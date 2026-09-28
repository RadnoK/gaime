import type { BasePlayer, BaseWorld, PlayerOf } from '../shared/types';
import { findPlayer, hydrate, nextId, pushFeed } from '../shared/world';
import { resolveNetwork } from '../shared/net';
import { collectBehaviour, type CommandHandler, type EventHandler, type Modifier, type Owned, type SystemDef, type SystemPhase } from '../shared/registry';
import { addTimer, cancelTimer, cancelTimers, countTimers, createSchedule, takeDue, timerLeft } from '../shared/schedule';
import type { GameContext, GameDefinition } from './game';
import { createChat } from './chat';

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
  /** Every dispatched bus event (tests record them). */
  observe?(event: string, data: unknown): void;
  random?: () => number;
  /** Throw module errors instead of disabling the module (tests). */
  strict?: boolean;
}

type Command = { type: string; [key: string]: unknown };
type Job<W extends BaseWorld> = { apply: (world: W, result: unknown, ctx: GameContext<W>) => void; fail?: (world: W, error: Error, ctx: GameContext<W>) => void; result?: unknown; error?: Error };
type RunningSystem = { owner: string; def: SystemDef; name: string; next: number; last: number };

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
    this.ctx = this.context();
    this.chatHandler = createChat(game as GameDefinition<W, unknown>, {
      ctx: this.ctx,
      bots: !!game.bot,
      rename: (id, name) => this.rename(id, name),
      pause: (id, paused) => this.command(id, { type: paused ? '$pause' : '$resume' }),
    });
  }

  // ── the tick ──────────────────────────────────────────────────────

  /** Advance one fixed tick. `inputs` are the humans' current inputs; bots are added here. */
  step(inputs: Readonly<Record<string, I>> = {}) {
    this.applyJobs();
    const world = this.world;
    if (world.pause) return;
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
  }

  private runSystems(phase: SystemPhase) {
    for (const system of this.systems[phase]) {
      if (this.world.pause) return;
      if (this.disabledModules[system.owner]) continue;
      const every = system.def.every;
      let dt = this.dt;
      if (every) {
        if (this.world.time < system.next) continue;
        dt = this.world.time - system.last;
        system.last = this.world.time;
        system.next = system.next + every > this.world.time ? system.next + every : this.world.time + every;
      }
      const started = performance.now();
      this.unit(() => this.isolate(system.owner, () => system.def.run(this.simFor(dt), dt)));
      this.host.profile?.(system.name, performance.now() - started);
    }
  }

  /** Periodic systems start staggered from the current world time (after construction and every load). */
  private alignSystems() {
    for (const system of [...this.systems.input, ...this.systems.update, ...this.systems.late]) {
      const every = system.def.every ?? 0;
      system.next = this.world.time + fraction(system.name) * every;
      system.last = system.next - every;
    }
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
          this.host.profile?.(handler.label, performance.now() - started);
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
      this.unit(() => this.isolate('game', () => {
        if (job.error) job.fail?.(this.world, job.error, this.ctx);
        else job.apply(this.world, job.result, this.ctx);
      }));
    }
    this.host.changed?.();
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

  /** Creates a player with a unique name (not online yet). */
  addPlayer(id: string, name: string): PlayerOf<W> {
    return this.unit(() => {
      const player = this.game.createPlayer(this.world, id, this.freeName(id, cleanName(name) || `Player ${Object.keys(this.world.players).length + 1}`), this.ctx);
      this.world.players[id] = player;
      this.trigger('player.joined', { player: id, bot: false });
      return player;
    });
  }

  addBot(name?: string): string {
    if (!this.game.bot) throw new Error('This game has no bot() brain (GameDefinition.bot).');
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
    this.unit(() => {
      this.isolate('game', () => this.game.onPlayerRemoved?.(this.world, player, this.ctx));
      this.trigger('player.removed', { player: id, name: player.name });
      delete this.world.players[id];
      cancelTimers(this.world.schedule, `player:${id}:`);
    });
    this.ensureHost();
    this.host.changed?.();
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
      random: engine.host.random ?? Math.random,
      isHost: playerId => engine.world.hostId === playerId,
      removePlayer: playerId => {
        const player = engine.world.players[playerId];
        if (!player) return;
        engine.host.disconnect?.(playerId);
        pushFeed(engine.world, `${player.name} left the game.`);
        engine.release(playerId);
      },
      save: () => engine.host.changed?.(),
      emit: (name, data, playerId) => engine.host.send(name, data, playerId),
      job: (work, apply, fail) => {
        const job: Job<W> = { apply: apply as Job<W>['apply'], fail: fail as Job<W>['fail'] };
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
    };
    return ctx;
  }

  /** Run code from outside the tick (requests, admin commands) and dispatch the events it triggers. */
  outside<T>(run: () => T): T {
    try { return this.unit(run); } finally { this.host.changed?.(); }
  }
}
