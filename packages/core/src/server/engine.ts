import type { BasePlayer, BaseWorld, Data, Pause, PlayerOf } from '../shared/types';
import { findPlayer, hydrate, nextId, pushFeed } from '../shared/world';
import { mulberry } from '../shared/math';
import { resolveNetwork } from '../shared/net';
import { collectBehaviour, type CommandHandler, type EventHandler, type Modifier, type Owned, type SystemDef, type SystemPhase } from '../shared/registry';
import { addTimer, cancelTimer, cancelTimers, countTimers, createSchedule, takeDue, timerLeft } from '../shared/schedule';
import { SpatialHash } from '../kit/spatial';
import type { GameContext, GameDefinition, ResourceOptions } from './game';
import { createChat } from './chat';
import { Recorder, type EngineState } from './recorder';

/** What the engine needs from its surroundings: the network room, or a test harness. */
export interface EngineHost {
  /** Private message to one player. */
  notify(playerId: string, text: string): void;
  /** Client event (`ctx.emit`, forwarded bus events) — to everyone or one player. */
  send(name: string, data: unknown, playerId?: string): void;
  /** Close the connections of a player that is being removed. */
  disconnect?(playerId: string): void;
  /** An error in game-owned code paused the game. */
  failed?(error: unknown): void;
  /** The host resumed the game (clears a reported error). */
  resumed?(): void;
  /** A module was disabled after an error. */
  disabled?(owner: string, error: unknown): void;
  /** World state changed outside the tick (publish and save soon). */
  changed?(): void;
  /** Time spent in one system / handler / command, for `/gaime/stats`. */
  profile?(name: string, ms: number): void;
  /** The room this engine runs in (id and invite code). Default `{ id: 'local' }`. */
  room?: { id: string; code?: string };
  /** `ctx.lockRoom` — stop or allow joins (matches mode). */
  lockRoom?(locked: boolean): void;
  /** Every dispatched bus event (tests record them). */
  observe?(event: string, data: unknown): void;
  random?: () => number;
  /** Throw module errors instead of disabling the module (tests). */
  strict?: boolean;
  /** Enforce `GameDefinition.budget` (measures wall-clock time: off in tests and replays). */
  budget?: boolean;
  /** A module's systems were throttled (factor 2, 4, 8) or recovered (1). */
  throttled?(owner: string, factor: number, msPerTick: number): void;
  /** Keep a flight recording of the last `minutes` (see recorder.ts). */
  record?: { minutes: number; maxEntries?: number };
  /** Replaying a recording: no recording, no budget, jobs and throttling come from the entries. */
  replaying?: boolean;
}

type Command = { type: string; [key: string]: unknown };
type Job<W extends BaseWorld> = { n: number; apply: (world: W, result: unknown, ctx: GameContext<W>) => void; fail?: (world: W, error: Error, ctx: GameContext<W>) => void; result?: unknown; error?: Error };
type RunningSystem = { owner: string; def: SystemDef; name: string; next: number; last: number };
type Positioned = { id?: string; x: number; z: number };
type Index = { hash: SpatialHash<Positioned>; tick: number; margin: number; maxRadius: number };

const BOT = 'gaime-bot';
/** Events in one dispatch cycle before the engine calls it a storm (a handler triggering itself). */
const MAX_EVENTS_PER_TICK = 50_000;
/** Timers fired per tick; the rest fire on the following ticks, spreading load spikes. */
const MAX_TIMERS_PER_TICK = 5_000;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const cleanName = (raw: string) => raw.replace(/\s+/g, ' ').trim().slice(0, 24);

/** Deterministic 0..1 from a string: staggers periodic systems. */
function fraction(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

/**
 * The game simulation without the network: the world, the clock, the event bus, timers,
 * systems, commands, jobs, bots and the player lifecycle. The room drives it with inputs
 * and connections; `testGame` drives it directly — the same code path in both.
 *
 * One tick (`step(inputs)`), unless paused:
 *   1. finished jobs are applied
 *   2. `time += dt`, `tick++`; due timers fire their events
 *   3. `input` systems → `game.step` → `update` systems → `late` systems
 * Events triggered anywhere are dispatched after the piece of code that triggered them.
 * Code owned by a module runs isolated: an exception disables that module, not the game.
 */
export class Engine<W extends BaseWorld, I = unknown> {
  world: W;
  readonly ctx: GameContext<W>;
  readonly dt: number;
  /** Modules disabled after an error: owner → message. Cleared by a new engine (code load). */
  readonly disabledModules: Record<string, string> = {};
  /** Counters since the engine started. */
  readonly counters = { events: 0, timers: 0, deferredTimers: 0 };

  private readonly handlers = new Map<string, Array<Owned<EventHandler> & { label: string }>>();
  private readonly modifiers = new Map<string, Array<Owned<Modifier>>>();
  private readonly systems: Record<SystemPhase, RunningSystem[]> = { input: [], update: [], late: [] };
  private readonly commands: Record<string, Owned<CommandHandler>> = {};
  private readonly forwarded: Set<string>;
  private readonly queue: Array<{ event: string; data: unknown }> = [];
  private readonly jobs: Job<W>[] = [];
  private readonly chatHandler: ReturnType<typeof createChat<W>>;
  private dispatching = false;
  /** Pieces of work in progress: events wait until the outermost one finishes. */
  private depth = 0;
  private eventsThisTick = 0;
  private sim: { key: string; value: unknown } | undefined;
  private readonly resources = new Map<string, { value: unknown; options: ResourceOptions<any> }>();
  /** Resource state from a recording, waiting for the code to ask for that resource (replays). */
  private readonly savedResources = new Map<string, unknown>();
  private readonly indexes = new Map<string, Index>();
  /** Budget: throttle factor per module, time spent per module since the last review. */
  readonly throttle: Record<string, number> = {};
  private readonly spent = new Map<string, number>();
  private budgetTicks = 0;
  private readonly budgetMs: number;
  /** Jobs are numbered in creation order (deterministic), so a replay can match their results. */
  private jobSeq = 0;
  private readonly replayJobs = new Map<number, Job<W>>();
  readonly recorder?: Recorder<W>;

  constructor(readonly game: GameDefinition<W, I>, readonly host: EngineHost, world?: W) {
    this.world = world ?? game.createWorld();
    this.dt = 1 / (game.tickRate ?? 30);
    this.forwarded = resolveNetwork(game.network).events;
    // The game's own behaviour first, then modules in registry (file) order.
    const behaviour = { handlers: [] as Array<Owned<{ event: string; run: EventHandler }>>, modifiers: [] as Array<Owned<{ name: string; run: Modifier }>>, systems: [] as Array<Owned<SystemDef>>, commands: {} as Record<string, Owned<CommandHandler>> };
    collectBehaviour(behaviour, { on: game.on, modify: game.modify, systems: game.systems, commands: game.commands }, 'game', `game ${game.name}`);
    const features = game.features;
    for (const handler of [...behaviour.handlers, ...(features?.handlers ?? [])]) {
      const list = this.handlers.get(handler.value.event) ?? [];
      list.push({ owner: handler.owner, value: handler.value.run, label: `${handler.owner} on ${handler.value.event}` });
      this.handlers.set(handler.value.event, list);
    }
    for (const modifier of [...behaviour.modifiers, ...(features?.modifiers ?? [])]) {
      const list = this.modifiers.get(modifier.value.name) ?? [];
      list.push({ owner: modifier.owner, value: modifier.value.run });
      this.modifiers.set(modifier.value.name, list);
    }
    for (const system of [...behaviour.systems, ...(features?.systems ?? [])]) {
      this.systems[system.value.phase ?? 'update'].push({ owner: system.owner, def: system.value, name: `${system.owner}/${system.value.id}`, next: 0, last: 0 });
    }
    this.alignSystems();
    Object.assign(this.commands, behaviour.commands);
    for (const [type, command] of Object.entries(features?.commands ?? {})) {
      if (this.commands[type]) throw new Error(`Module ${command.owner}: command "${type}" is already handled by the game.`);
      this.commands[type] = command;
    }
    const budget = game.budget ?? {};
    this.budgetMs = host.budget && !host.replaying && budget.enabled !== false ? budget.moduleMs ?? (1000 * this.dt) * 0.2 : 0;
    if (host.record && !host.replaying && game.record?.enabled !== false) this.recorder = new Recorder(this, host.record.minutes, host.record.maxEntries);
    this.ctx = this.context();
    this.chatHandler = createChat(game as GameDefinition<W, unknown>, {
      ctx: this.ctx,
      bots: !!game.bot,
      rename: (id, name) => this.rename(id, name),
      pause: (id, paused) => this.command(id, { type: paused ? '$pause' : '$resume' }),
      // A replay runs faster than real time: the chat flood limit would reject recorded messages.
      unlimited: !!host.replaying,
    });
  }

  // ── the tick ──────────────────────────────────────────────────────

  /** Advance one fixed tick. `inputs` are the humans' current inputs; bots are added here. */
  step(inputs: Readonly<Record<string, I>> = {}) {
    this.recorder?.inputs(inputs);
    this.applyJobs();
    const world = this.world;
    if (world.pause) return;
    if (this.budgetMs) this.review();
    let all = inputs;
    if (this.game.bot) {
      const bots: Record<string, I> = {};
      for (const player of Object.values(world.players)) {
        if (!player.data[BOT]) continue;
        const input = this.unit(() => this.isolate('game', () => this.game.bot!(world, player.id, this.ctx)));
        if (input !== undefined) bots[player.id] = input;
      }
      all = { ...inputs, ...bots };
    }
    world.time += this.dt;
    world.tick = (world.tick ?? 0) + 1;
    world.schedule ??= createSchedule();
    const due = takeDue(world.schedule, world.time, MAX_TIMERS_PER_TICK);
    if (due.length === MAX_TIMERS_PER_TICK) this.counters.deferredTimers++;
    this.counters.timers += due.length;
    for (const timer of due) this.queue.push({ event: timer.event, data: timer.data });
    this.dispatch();
    this.runSystems('input');
    if (this.game.step && !world.pause) {
      const started = performance.now();
      this.unit(() => this.isolate('game', () => this.game.step!(world, all, this.dt, this.ctx, this.simFor(this.dt))));
      this.host.profile?.('game/step', performance.now() - started);
    }
    this.runSystems('update');
    this.runSystems('late');
    this.ensureHost();
    this.recorder?.afterStep();
  }

  private runSystems(phase: SystemPhase) {
    for (const system of this.systems[phase]) {
      if (this.world.pause) return;
      if (this.disabledModules[system.owner]) continue;
      // A module over its time budget runs its systems only every `factor`-th tick (staggered).
      const factor = this.throttle[system.owner];
      if (factor > 1 && (this.world.tick + Math.floor(fraction(system.name) * factor)) % factor !== 0) continue;
      const every = system.def.every;
      let dt = factor > 1 ? this.world.time - system.last : this.dt;
      if (every) {
        if (this.world.time < system.next) continue;
        dt = this.world.time - system.last;
        system.next = system.next + every > this.world.time ? system.next + every : this.world.time + every;
      }
      system.last = this.world.time;
      const started = performance.now();
      this.unit(() => this.isolate(system.owner, () => system.def.run(this.simFor(dt), dt)));
      const ms = performance.now() - started;
      this.host.profile?.(system.name, ms);
      this.charge(system.owner, ms);
    }
  }

  /** Periodic systems start staggered from the current world time (after construction and every load). */
  private alignSystems() {
    for (const system of this.allSystems()) {
      const every = system.def.every ?? 0;
      system.next = this.world.time + fraction(system.name) * every;
      system.last = every ? system.next - every : this.world.time - this.dt;
    }
  }

  private allSystems() { return [...this.systems.input, ...this.systems.update, ...this.systems.late]; }

  // ── budget ────────────────────────────────────────────────────────

  private charge(owner: string, ms: number) {
    if (this.budgetMs && owner !== 'game') this.spent.set(owner, (this.spent.get(owner) ?? 0) + ms);
  }

  /** Once a second: throttle modules over budget (×2 up to ×8), relax the ones well under it. */
  private review() {
    if (++this.budgetTicks < Math.round(1 / this.dt)) return;
    const ticks = this.budgetTicks;
    this.budgetTicks = 0;
    for (const owner of new Set([...this.spent.keys(), ...Object.keys(this.throttle)])) {
      const perTick = (this.spent.get(owner) ?? 0) / ticks;
      const factor = this.throttle[owner] ?? 1;
      if (perTick > this.budgetMs && factor < 8) this.setThrottle(owner, factor * 2, perTick);
      else if (factor > 1 && perTick * factor < this.budgetMs / 2) this.setThrottle(owner, factor / 2, perTick);
    }
    this.spent.clear();
  }

  setThrottle(owner: string, factor: number, perTick = 0) {
    const previous = this.throttle[owner] ?? 1;
    if (factor <= 1) delete this.throttle[owner]; else this.throttle[owner] = factor;
    this.recorder?.entry('throttle', owner, factor);
    // The feed is part of the world: the same lines in a replay (without the live measurements).
    if (factor > previous) pushFeed(this.world, `⚡ Module "${owner}" is over its time budget: its systems now run every ${factor} ticks.`);
    else if (factor === 1) pushFeed(this.world, `Module "${owner}" is back within its time budget.`);
    if (!this.host.replaying) this.host.throttled?.(owner, factor, perTick);
  }

  /** What handlers and systems receive: the game's `Sim`, cached per tick and `dt`. */
  simFor(dt: number): unknown {
    if (!this.game.sim) return this.ctx;
    const key = `${this.world.tick}:${dt}`;
    if (this.sim?.key !== key) this.sim = { key, value: this.game.sim(this.ctx, dt) };
    return this.sim.value;
  }

  // ── events ────────────────────────────────────────────────────────

  trigger(event: string, data: unknown) {
    if (++this.eventsThisTick > MAX_EVENTS_PER_TICK) {
      this.queue.length = 0;
      throw new Error(`Event storm: more than ${MAX_EVENTS_PER_TICK} events at once (last: "${event}"). Does a handler trigger the event it handles?`);
    }
    this.queue.push({ event, data });
  }

  /**
   * Run one piece of work (a system, `step`, a command, a player change); queued events are
   * dispatched when the outermost piece finishes — never in the middle of someone's code.
   */
  private unit<T>(run: () => T): T {
    this.depth++;
    try { return run(); } finally { this.depth--; if (this.depth === 0) this.dispatch(); }
  }

  /** Run the handlers of every queued event, including events they trigger (FIFO). */
  dispatch() {
    if (this.dispatching || this.depth > 0) return;
    this.dispatching = true;
    try {
      for (let index = 0; index < this.queue.length; index++) {
        const { event, data } = this.queue[index];
        this.counters.events++;
        this.host.observe?.(event, data);
        if (this.forwarded.has(event)) this.host.send(event, data);
        const handlers = this.handlers.get(event);
        if (!handlers) continue;
        for (const handler of handlers) {
          if (this.disabledModules[handler.owner]) continue;
          const started = performance.now();
          this.isolate(handler.owner, () => handler.value(data, this.simFor(this.dt)));
          const ms = performance.now() - started;
          this.host.profile?.(handler.label, ms);
          this.charge(handler.owner, ms);
        }
      }
    } finally {
      this.queue.length = 0;
      this.dispatching = false;
      this.eventsThisTick = 0;
    }
  }

  modify<T>(name: string, value: T, data?: unknown): T {
    const modifiers = this.modifiers.get(name);
    if (!modifiers) return value;
    let result = value;
    for (const modifier of modifiers) {
      if (this.disabledModules[modifier.owner]) continue;
      const next = this.isolate(modifier.owner, () => modifier.value(result, data, this.simFor(this.dt)));
      if (next !== undefined) result = next as T;
    }
    return result;
  }

  // ── isolation ─────────────────────────────────────────────────────

  isolate<T>(owner: string, run: () => T): T | undefined {
    if (owner !== 'game' && this.disabledModules[owner]) return undefined;
    try { return run(); }
    catch (error) {
      if (owner === 'game') this.fail(error);
      else this.disable(owner, error);
      return undefined;
    }
  }

  /** An error in game-owned code pauses the game; the next code load resumes it. */
  fail(error: unknown) {
    if (this.host.strict) throw error;
    console.error('[gaime] simulation', error);
    this.world.pause = { reason: 'error', message: message(error) };
    pushFeed(this.world, `⚠ Game code error: ${message(error)}. The game is paused — push a fix, new code resumes it.`);
    this.host.failed?.(error);
    this.host.changed?.();
  }

  /** An error in a module disables that module only; the next code load re-enables it. */
  disable(owner: string, error: unknown) {
    if (this.host.strict) throw error;
    if (this.disabledModules[owner]) return;
    console.error(`[gaime] module ${owner}`, error);
    this.disabledModules[owner] = message(error);
    pushFeed(this.world, `⚠ Module "${owner}" was switched off after an error: ${message(error)}. The rest of the game keeps running; a fix switches it back on.`);
    this.host.disabled?.(owner, error);
    this.host.changed?.();
  }

  // ── commands, chat, jobs ──────────────────────────────────────────

  /** A player's (or bot's) command. An error in the handler becomes the reply, never an exception. */
  command(playerId: string, command: Command): string | void {
    if (!this.world.players[playerId] || typeof command?.type !== 'string') return;
    this.external('cmd', playerId, command);
    this.depth++;
    try {
      if (command.type.startsWith('$')) return this.engineCommand(playerId, command);
      const feature = this.commands[command.type];
      const started = performance.now();
      try {
        if (feature) {
          if (this.disabledModules[feature.owner]) return `"${command.type}" is switched off after an error in module ${feature.owner}.`;
          return feature.value(playerId, command, this.simFor(0));
        }
        if (!this.game.command) return `Unknown command ${command.type}.`;
        return this.game.command(this.world, playerId, command, this.ctx);
      } catch (error) {
        if (this.host.strict) throw error;
        console.error(`[gaime] command ${command.type}`, error);
        return `Error in the code of command "${command.type}": ${message(error)}`;
      } finally {
        this.host.profile?.(`${feature?.owner ?? 'game'} command ${command.type}`, performance.now() - started);
      }
    } finally {
      this.depth--;
      if (this.depth === 0) this.dispatch();
      this.host.changed?.();
    }
  }

  private engineCommand(id: string, command: Command): string | void {
    const player = this.world.players[id];
    if (command.type === '$chat') return this.chatHandler(this.world, id, command.text);
    if (command.type === '$pause' || command.type === '$resume') {
      if (this.world.hostId !== id) return 'Only the host can pause or resume the game.';
      if (this.frozen) return 'The save did not load — fix the code first.';
      this.world.pause = command.type === '$pause' ? { reason: 'host' } : null;
      if (command.type === '$resume') this.host.resumed?.();
      pushFeed(this.world, `${player.name} ${command.type === '$pause' ? 'paused' : 'resumed'} the game.`);
      return;
    }
    return `Unknown command ${command.type}.`;
  }

  /** Set by the room when the save could not be loaded: the game must stay paused. */
  frozen: string | null = null;

  applyJobs() {
    if (!this.jobs.length) return;
    for (const job of this.jobs.splice(0)) {
      this.recorder?.entry('job', job.n, !job.error, job.error ? job.error.message : job.result);
      this.runJob(job);
    }
    this.host.changed?.();
  }

  private runJob(job: Job<W>) {
    this.unit(() => this.isolate('game', () => {
      if (job.error) job.fail?.(this.world, job.error, this.ctx);
      else job.apply(this.world, job.result, this.ctx);
    }));
  }

  /** Replay: apply a recorded job result to the job the replayed code created with the same number. */
  replayJob(n: number, ok: boolean, value: unknown) {
    const job = this.replayJobs.get(n);
    if (!job) return;
    this.replayJobs.delete(n);
    if (ok) job.result = value; else job.error = new Error(String(value));
    this.runJob(job);
  }

  /** Wait for every pending job and apply the results (tests). */
  async settleJobs(pending: Array<Promise<unknown>>) {
    await Promise.allSettled(pending);
    await new Promise(resolve => setTimeout(resolve, 0));
    this.applyJobs();
  }

  // ── players ───────────────────────────────────────────────────────

  nameTaken(id: string, name: string) {
    return Object.values(this.world.players).some(other => other.id !== id && other.name.toLowerCase() === name.toLowerCase());
  }

  /** `name`, or `name 2`, `name 3`… when another player already uses it. */
  freeName(id: string, name: string) {
    let candidate = name;
    for (let n = 2; this.nameTaken(id, candidate); n++) candidate = `${name.slice(0, 20)} ${n}`;
    return candidate;
  }

  rename(id: string, raw: string): string | void {
    const name = cleanName(raw);
    const player = this.world.players[id];
    if (!player || !name) return 'Usage: /nick <new nick>';
    if (this.nameTaken(id, name)) return `The nickname "${name}" is taken.`;
    pushFeed(this.world, `${player.name} is now known as ${name}.`);
    player.name = name;
    this.host.changed?.();
  }

  /** Creates a player with a unique name (not online yet). `data`: engine flags such as `gaime-ephemeral`. */
  addPlayer(id: string, name: string, data?: Data): PlayerOf<W> {
    this.external('join', id, name, data ?? null);
    return this.unit(() => {
      const player = this.game.createPlayer(this.world, id, this.freeName(id, cleanName(name) || `Player ${Object.keys(this.world.players).length + 1}`), this.ctx);
      if (data) Object.assign(player.data, data);
      this.world.players[id] = player;
      this.trigger('player.joined', { player: id, bot: false });
      return player;
    });
  }

  addBot(name?: string): string {
    if (!this.game.bot) throw new Error('This game has no bot() brain (GameDefinition.bot).');
    this.external('bot', name ?? null);
    // From the world's id counter: deterministic in seeded tests, unique across restarts.
    const id = `bot-${nextId(this.world)}`;
    const count = Object.values(this.world.players).filter(p => p.data[BOT]).length;
    this.unit(() => {
      const player = this.game.createPlayer(this.world, id, this.freeName(id, cleanName(name ?? '') || `Bot ${count + 1}`), this.ctx);
      player.data[BOT] = true;
      player.online = true;
      this.world.players[id] = player;
      pushFeed(this.world, `🤖 ${player.name} joined the game.`);
      this.trigger('player.joined', { player: id, bot: true });
      this.isolate('game', () => this.game.onPlayerOnline?.(this.world, player, true, this.ctx));
      this.trigger('player.online', { player: id });
    });
    this.host.changed?.();
    return id;
  }

  setOnline(id: string, online: boolean) {
    const player = this.world.players[id] as PlayerOf<W> | undefined;
    if (!player) return;
    this.external('online', id, online);
    player.online = online;
    this.unit(() => {
      this.isolate('game', () => this.game.onPlayerOnline?.(this.world, player, online, this.ctx));
      this.trigger(online ? 'player.online' : 'player.offline', { player: id });
    });
    this.ensureHost();
    this.host.changed?.();
  }

  /** Deletes a player from the world (after `onPlayerRemoved`) and their timers keyed `player:<id>:`. */
  release(id: string) {
    const player = this.world.players[id] as PlayerOf<W> | undefined;
    if (!player) return;
    this.external('release', id);
    this.unit(() => {
      this.isolate('game', () => this.game.onPlayerRemoved?.(this.world, player, this.ctx));
      this.trigger('player.removed', { player: id, name: player.name });
      delete this.world.players[id];
      cancelTimers(this.world.schedule, `player:${id}:`);
    });
    this.ensureHost();
    this.host.changed?.();
  }

  /** A returning player asked for another (free) name in the lobby. */
  setName(id: string, name: string) {
    const player = this.world.players[id];
    if (!player || player.name === name) return;
    this.external('name', id, name);
    player.name = name;
    this.host.changed?.();
  }

  // ── operator actions (recorded, so replays include them) ──────────

  say(text: string) {
    this.external('say', text);
    pushFeed(this.world, `📣 ${text.slice(0, 280)}`);
    this.host.changed?.();
  }

  setPause(pause: Pause | null) {
    this.external('pause', pause);
    this.world.pause = pause;
    if (!pause) this.host.resumed?.();
    this.host.changed?.();
  }

  /** `GameDefinition.admin[name]` — the operator's `gaime admin <name> …`. */
  admin(name: string, args: string[]): unknown {
    const command = this.game.admin?.[name];
    if (!command) throw new Error(`Unknown admin command "${name}". Available: ${Object.keys(this.game.admin ?? {}).join(', ') || 'none'}`);
    this.external('admin', name, args);
    return this.unit(() => command.run(this.world, args, this.ctx));
  }

  /** `GameDefinition.requests[name]` for a player (RPC). The synchronous part runs like a command. */
  request(playerId: string, name: string, payload: unknown): unknown {
    const handler = this.game.requests?.[name];
    if (!handler) throw new Error(`Unknown request "${name}".`);
    this.external('req', playerId, name, payload ?? null);
    try { return this.unit(() => handler(this.world, playerId, payload, this.ctx)); } finally { this.host.changed?.(); }
  }

  // ── recording ─────────────────────────────────────────────────────

  /** Record an input from outside the simulation (only at the top level: nested calls replay by themselves). */
  private external(type: string, ...args: unknown[]) {
    if (this.recorder && this.depth === 0 && !this.dispatching) this.recorder.entry(type, ...args);
  }

  /** Engine runtime state a replay needs besides the world. */
  saveState(inputs: Record<string, unknown>): EngineState {
    return {
      systems: Object.fromEntries(this.allSystems().map(system => [system.name, [system.next, system.last]])),
      throttle: { ...this.throttle },
      disabled: { ...this.disabledModules },
      jobs: this.jobSeq,
      inputs,
      resources: Object.fromEntries([...this.resources].flatMap(([key, entry]) => {
        const data = entry.options.save?.(entry.value);
        return data === undefined ? [] : [[key, data]];
      })),
    };
  }

  loadState(state: EngineState) {
    for (const system of this.allSystems()) {
      const saved = state.systems[system.name];
      if (saved) [system.next, system.last] = saved;
    }
    Object.assign(this.throttle, state.throttle);
    Object.assign(this.disabledModules, state.disabled);
    this.jobSeq = state.jobs;
    for (const [key, data] of Object.entries(state.resources ?? {})) this.savedResources.set(key, data);
  }

  ensureHost() {
    const current = this.world.hostId ? this.world.players[this.world.hostId] : undefined;
    if (current?.online && !current.data[BOT]) return;
    const next = Object.values(this.world.players).find(player => player.online && !player.data[BOT]);
    this.world.hostId = next?.id ?? null;
  }

  // ── loading ───────────────────────────────────────────────────────

  /** Fill new fields from defaults (a sandboxed template player), then the game's migration. */
  load(raw: unknown): W {
    const scratch = new Engine(this.game, { notify() {}, send() {} });
    scratch.ctx.addBot = () => { throw new Error('addBot is not available while building the player template.'); };
    const template = this.game.createPlayer(scratch.world, 'template', 'template', scratch.ctx) as BasePlayer;
    const world = hydrate(structuredClone(raw), this.game.createWorld(), template);
    return this.game.migrate ? this.game.migrate(world) : world;
  }

  /** After a load, a hot reload or the first start: bots online, errors cleared, `game.prepare`. */
  prepare(version: string) {
    this.world.version = version;
    this.world.schedule ??= createSchedule();
    this.world.tick ??= 0;
    this.alignSystems();
    if (!this.frozen && this.world.pause?.reason === 'error') this.world.pause = null;
    for (const player of Object.values(this.world.players)) if (player.data[BOT]) player.online = true;
    this.unit(() => this.isolate('game', () => this.game.prepare?.(this.world, this.ctx)));
    this.ensureHost();
    // `prepare` follows every load of a world (checkpoint, hot-reload cache): record from here.
    this.recorder?.restart();
  }

  // ── resources and spatial indexes ─────────────────────────────────

  resource<T>(key: string, create: () => T, options?: ((value: T) => void) | ResourceOptions<T>): T {
    let entry = this.resources.get(key);
    if (!entry) {
      const resolved: ResourceOptions<T> = typeof options === 'function' ? { dispose: options } : options ?? {};
      const saved = this.savedResources.get(key);
      this.savedResources.delete(key);
      entry = { value: saved !== undefined && resolved.load ? resolved.load(saved) : create(), options: resolved };
      this.resources.set(key, entry);
    }
    return entry.value as T;
  }

  /** The code is being replaced (hot reload, shutdown): release resources. */
  dispose() {
    for (const [key, entry] of this.resources) {
      try { entry.options.dispose?.(entry.value); } catch (error) { console.error(`[gaime] dispose ${key}`, error); }
    }
    this.resources.clear();
    this.indexes.clear();
  }

  private index(collection: string, force = false): Index {
    const options = this.game.spatial?.[collection];
    if (!options) throw new Error(`"${collection}" is not a spatial collection — add it to GameDefinition.spatial.`);
    let index = this.indexes.get(collection);
    if (!index) {
      index = { hash: new SpatialHash<Positioned>(options.cell ?? 4), tick: -1, margin: options.margin ?? 1, maxRadius: options.maxRadius ?? Infinity };
      this.indexes.set(collection, index);
    }
    if (force || index.tick !== this.world.tick) {
      const started = performance.now();
      const items = (this.world as unknown as Record<string, Record<string, Positioned> | undefined>)[collection];
      index.hash.rebuild(items ? Object.values(items) : []);
      index.tick = this.world.tick;
      this.host.profile?.(`spatial ${collection}`, performance.now() - started);
    }
    return index;
  }

  near<T extends Positioned>(collection: string, at: { x: number; z: number }, radius: number, filter?: (item: T) => boolean): T[] {
    const index = this.index(collection);
    const items = (this.world as unknown as Record<string, Record<string, Positioned>>)[collection] ?? {};
    // The index may be a tick old: search a little wider, then check the live entities exactly.
    return index.hash.query(at, radius + index.margin).filter(item => {
      if (item.id !== undefined && items[item.id] !== item) return false;
      const dx = item.x - at.x; const dz = item.z - at.z;
      return dx * dx + dz * dz <= radius * radius && (!filter || filter(item as T));
    }) as T[];
  }

  nearest<T extends Positioned>(collection: string, at: { x: number; z: number }, radius?: number, filter?: (item: T) => boolean): T | undefined {
    const limit = radius ?? this.index(collection).maxRadius;
    if (Number.isFinite(limit)) {
      let best: T | undefined; let bestD = Infinity;
      for (const item of this.near<T>(collection, at, limit, filter)) {
        const d = (item.x - at.x) ** 2 + (item.z - at.z) ** 2;
        if (d < bestD) { bestD = d; best = item; }
      }
      return best;
    }
    // Unbounded: a few widening rings through the index, then a plain scan (a huge ring would visit empty cells).
    const cell = this.game.spatial![collection].cell ?? 4;
    for (const r of [cell, cell * 4, cell * 16]) {
      const found = this.nearest<T>(collection, at, r, filter);
      if (found) return found;
    }
    let best: T | undefined; let bestD = Infinity;
    for (const item of Object.values((this.world as unknown as Record<string, Record<string, T>>)[collection] ?? {})) {
      if (filter && !filter(item)) continue;
      const d = (item.x - at.x) ** 2 + (item.z - at.z) ** 2;
      if (d < bestD) { bestD = d; best = item; }
    }
    return best;
  }

  // ── context ───────────────────────────────────────────────────────

  private context(): GameContext<W> {
    const engine = this;
    const schedule = () => (engine.world.schedule ??= createSchedule());
    const ctx: GameContext<W> = {
      get world() { return engine.world; },
      log: text => { pushFeed(engine.world, text); },
      notify: (playerId, text) => engine.host.notify(playerId, text),
      nextId: () => nextId(engine.world),
      // The world's own generator (state in world.rng): deterministic, saved, replayable.
      random: engine.host.random ?? (() => {
        const [state, value] = mulberry(Number.isFinite(engine.world.rng) ? engine.world.rng : 1);
        engine.world.rng = state;
        return value;
      }),
      isHost: playerId => engine.world.hostId === playerId,
      removePlayer: playerId => {
        const player = engine.world.players[playerId];
        if (!player) return;
        engine.external('remove', playerId);
        engine.host.disconnect?.(playerId);
        engine.unit(() => {
          pushFeed(engine.world, `${player.name} left the game.`);
          engine.release(playerId);
        });
      },
      save: () => engine.host.changed?.(),
      emit: (name, data, playerId) => engine.host.send(name, data, playerId),
      job: (work, apply, fail) => {
        const job: Job<W> = { n: ++engine.jobSeq, apply: apply as Job<W>['apply'], fail: fail as Job<W>['fail'] };
        // A replay takes the result from the recording, at the tick it arrived live.
        if (engine.host.replaying) { engine.replayJobs.set(job.n, job); work.catch(() => {}); return; }
        work.then(result => { job.result = result; engine.jobs.push(job); }, error => { job.error = error instanceof Error ? error : new Error(String(error)); engine.jobs.push(job); });
      },
      findPlayer: query => findPlayer(engine.world.players, query) as PlayerOf<W> | undefined,
      addBot: name => engine.addBot(name),
      isBot: playerId => !!engine.world.players[playerId]?.data[BOT],
      command: (playerId, command) => engine.command(playerId, command),
      trigger: (event: string, data?: unknown) => engine.trigger(event, data),
      modify: (name, value, data) => engine.modify(name, value, data),
      after: (seconds: number, event: string, data?: unknown, options?: { key?: string }) => addTimer(schedule(), engine.world.time, seconds, event, data, { key: options?.key }),
      every: (seconds: number, event: string, data?: unknown, options?: { key?: string; times?: number }) => {
        const live = options?.key ? schedule().live[options.key] : undefined;
        if (live && live.event === event && live.every === seconds) return options!.key!;
        return addTimer(schedule(), engine.world.time, seconds, event, data, { ...options, every: seconds });
      },
      cancel: (key, options) => options?.prefix ? cancelTimers(schedule(), key) : Number(cancelTimer(schedule(), key)),
      timeLeft: key => timerLeft(schedule(), key, engine.world.time),
      timers: prefix => countTimers(schedule(), prefix),
      isolate: (owner, run) => engine.isolate(owner, run),
      disabled: owner => !!engine.disabledModules[owner],
      resource: (key, create, dispose) => engine.resource(key, create, dispose),
      near: (collection, at, radius, filter) => engine.near(collection, at, radius, filter),
      nearest: (collection, at, radius, filter) => engine.nearest(collection, at, radius, filter),
      reindex: collection => { engine.index(collection, true); },
      get room() { return engine.host.room ?? { id: 'local' }; },
      lockRoom: locked => engine.host.lockRoom?.(locked),
    };
    return ctx;
  }

  /**
   * Run arbitrary code from outside the tick and dispatch the events it triggers. It cannot be
   * recorded: prefer `request`, `admin`, `command` — a recording made across it is marked incomplete.
   */
  outside<T>(run: () => T): T {
    if (this.recorder && this.depth === 0) this.recorder.broken ??= 'code ran outside the tick (outside())';
    try { return this.unit(run); } finally { this.host.changed?.(); }
  }
}
