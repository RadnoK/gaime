import type { BaseWorld, PlayerOf } from '../shared/types';
import type { GameContext, GameDefinition } from './game';
import { Engine, type EngineHost } from './engine';
import type { Recording } from './recorder';

type Command = { type: string; [key: string]: unknown };
type Recorded = {
  notices: Array<{ playerId: string; text: string }>;
  /** Client events (`ctx.emit` and forwarded bus events). */
  events: Array<{ name: string; data: unknown; playerId?: string }>;
  /** Every bus event (`ctx.trigger`, timers) in dispatch order. */
  triggered: Array<{ event: string; data: unknown }>;
};

function recordingHost(options: { random?: () => number; strict?: boolean }, recorded: Recorded, jobs: Array<Promise<unknown>>): EngineHost {
  return {
    notify: (playerId, text) => { recorded.notices.push({ playerId, text }); },
    send: (name, data, playerId) => { recorded.events.push(playerId ? { name, data, playerId } : { name, data }); },
    observe: (event, data) => { recorded.triggered.push({ event, data }); },
    random: options.random,
    strict: options.strict ?? true,
  };
}

/** Tracks every `ctx.job` promise so tests can wait for them. */
function trackJobs<W extends BaseWorld>(ctx: GameContext<W>, jobs: Array<Promise<unknown>>) {
  const job = ctx.job;
  ctx.job = (work, apply, fail) => { jobs.push(work.catch(() => undefined)); job(work, apply, fail); };
}

/**
 * A `GameContext` for unit tests of game logic, without a room, network or game definition.
 * Bus events are recorded in `triggered` (no handlers run); timers fire with `advance(seconds)`.
 */
export function testContext<W extends BaseWorld>(world: W, options: { random?: () => number; command?: (playerId: string, command: Command) => string | void } = {}) {
  const recorded: Recorded = { notices: [], events: [], triggered: [] };
  const jobs: Array<Promise<unknown>> = [];
  const removed: string[] = [];
  const game: GameDefinition<W, unknown> = {
    name: 'test', createWorld: () => world, parseInput: raw => raw,
    createPlayer: () => { throw new Error('testContext: create players with your own createPlayer.'); },
  };
  const engine = new Engine(game, recordingHost(options, recorded, jobs), world);
  const ctx = engine.ctx;
  ctx.removePlayer = id => { removed.push(id); delete world.players[id]; };
  ctx.addBot = () => { throw new Error('testContext: use testGame(game) for bots, or createPlayer + data["gaime-bot"] = true.'); };
  ctx.command = (playerId, command) => options.command?.(playerId, command);
  // No tick drives this context: record triggered events right away.
  ctx.trigger = (event: string, data?: unknown) => { engine.trigger(event, data); engine.dispatch(); };
  trackJobs(ctx, jobs);
  return {
    ctx, removed, ...recorded,
    /** Wait for pending jobs and apply them, like the next tick would. */
    async flushJobs() { await engine.settleJobs(jobs.splice(0)); },
    /** Move `world.time` forward and fire the timers that become due (events are recorded, not handled). */
    advance(seconds: number) {
      const steps = Math.round(seconds / engine.dt);
      const pause = world.pause;
      world.pause = null;
      for (let i = 0; i < steps; i++) engine.step();
      world.pause = pause;
    },
  };
}

export interface TestGameOptions<W extends BaseWorld> {
  /** Seed of the world's random generator (`world.rng`, behind `ctx.random`): same seed, same game. */
  seed?: number;
  /** Replace `ctx.random` altogether (e.g. `seeded(n)`). Prefer `seed`: it also works with `record`. */
  random?: () => number;
  /** Keep a flight recording (`t.recording()`) to test replays; `maxEntries` forces early segment rotation. */
  record?: boolean | { maxEntries?: number };
  /** Enforce module time budgets (wall-clock based, so off by default in tests). */
  budget?: boolean;
  /** Start from this world instead of `createWorld()` (it is hydrated and migrated like a save). */
  world?: unknown;
  /**
   * Errors in module code throw (default) instead of switching the module off, so tests
   * fail loudly. Set `false` to test the isolation itself.
   */
  strict?: boolean;
}

/**
 * The whole game without a network: the same engine the server runs (clock, timers, event
 * bus, systems, commands, bots, jobs, player lifecycle), driven by the test.
 *
 *   const t = testGame(game, { random: seeded(1) });
 *   const ada = t.join('Ada');
 *   t.input(ada, { mx: 1, mz: 0 });
 *   t.run(2);                                   // 2 s of game time
 *   expect(t.command(ada, { type: 'start' })).toBeUndefined();
 */
export function testGame<W extends BaseWorld, I, S = GameContext<W>>(game: GameDefinition<W, I, S, any>, options: TestGameOptions<W> = {}) {
  const recorded: Recorded = { notices: [], events: [], triggered: [] };
  const jobs: Array<Promise<unknown>> = [];
  const engine = new Engine<W, I>(game as GameDefinition<W, I>, { ...recordingHost(options, recorded, jobs), budget: options.budget, record: options.record ? { minutes: game.record?.minutes ?? 60, maxEntries: typeof options.record === 'object' ? options.record.maxEntries : undefined } : undefined });
  if (options.world !== undefined) engine.world = engine.load(options.world);
  if (options.seed !== undefined) engine.world.rng = options.seed >>> 0;
  trackJobs(engine.ctx, jobs);
  engine.prepare('TEST');
  const inputs: Record<string, I> = {};
  let joined = 0;

  const t = {
    engine,
    ...recorded,
    get world() { return engine.world; },
    get ctx() { return engine.ctx; },
    /** Modules switched off after an error (with `strict: false`). */
    get disabled() { return engine.disabledModules; },
    /** A human player joins (created on first join, online afterwards). Returns the player id. */
    join(name: string, id = `p${++joined}`): string {
      if (!engine.world.players[id]) engine.addPlayer(id, name);
      engine.setOnline(id, true);
      return id;
    },
    leave(id: string) { delete inputs[id]; engine.setOnline(id, false); },
    /** Removes a player like a kick or a freed seat. */
    remove(id: string) { delete inputs[id]; engine.ctx.removePlayer(id); },
    addBot(name?: string) { return engine.addBot(name); },
    player(id: string) { return engine.world.players[id] as PlayerOf<W>; },
    /** What handlers and systems receive (the game's `Sim`), to read or call helpers from a test. */
    sim(dt = 0): S { return engine.simFor(dt) as S; },
    /**
     * Run code against the `Sim` like a system would: events it triggers are handled right after.
     *
     *   t.act(sim => sim.spawnPickup('coin', t.player(ada)));
     */
    act<T>(run: (sim: S) => T): T { return engine.outside(() => run(engine.simFor(engine.dt) as S)); },
    /** Hold an input for a player until it is changed or cleared with `undefined`. */
    input(id: string, input: I | undefined) { if (input === undefined) delete inputs[id]; else inputs[id] = input; },
    command(id: string, command: Command) { return engine.command(id, command); },
    chat(id: string, text: string) { return engine.command(id, { type: '$chat', text }); },
    async request(id: string, name: string, payload?: unknown) { return await engine.request(id, name, payload); },
    /** Operator command (`gaime admin <name> …`). */
    admin(name: string, ...args: string[]) { return engine.admin(name, args); },
    /** The flight recording so far (needs `record: true`) — feed it to `replay(game, recording)`. */
    recording(reason = 'test'): Recording {
      if (!engine.recorder) throw new Error('testGame: pass { record: true } to record.');
      return engine.recorder.toJSON(game as GameDefinition<W, I>, 'TEST', reason);
    },
    /** Advance `count` ticks. */
    tick(count = 1) { for (let i = 0; i < count; i++) engine.step(inputs); },
    /** Advance `seconds` of game time; `until` stops early when it returns true. Returns the ticks run. */
    run(seconds: number, until?: () => boolean) {
      const ticks = Math.round(seconds / engine.dt);
      for (let i = 0; i < ticks; i++) {
        engine.step(inputs);
        if (until?.()) return i + 1;
      }
      return ticks;
    },
    /** Wait for pending jobs (workers) and apply their results. */
    async flushJobs() { await engine.settleJobs(jobs.splice(0)); },
    /** Feed texts, newest last. */
    feed() { return engine.world.feed.map(item => item.text); },
    /** Bus events named `event` since the start (or since `clear()`). */
    triggeredOf(event: string) { return recorded.triggered.filter(item => item.event === event).map(item => item.data); },
    clear() { recorded.notices.length = 0; recorded.events.length = 0; recorded.triggered.length = 0; },
  };
  return t;
}
