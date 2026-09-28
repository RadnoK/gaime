import type { Application } from 'express';
import type { BaseWorld, PlayerOf } from '../shared/types';
import type { NetworkConfig } from '../shared/net';
import type { Behaviour, EngineEvents, EventMap, ModifierMap, PrivateEvent, Registry } from '../shared/registry';
import type { TimerOptions } from '../shared/schedule';

/** Engine services available to game code during `step`, `command` and hooks. */
export interface GameContext<W extends BaseWorld, E extends EventMap = EventMap, M extends ModifierMap = ModifierMap> {
  readonly world: W;
  /**
   * Put an event on the bus. Handlers (`on` of the game and of every module) run after the
   * current piece of work finishes, in the same tick, in a deterministic order. Payloads
   * must be plain JSON when the event is scheduled or forwarded to clients.
   */
  trigger<Name extends keyof E & string>(event: Name, data: E[Name]): void;
  trigger<Name extends keyof EngineEvents>(event: Name, data: EngineEvents[Name]): void;
  /** A module's private event `<module>:<event>` (no declaration needed). */
  trigger(event: PrivateEvent, data?: unknown): void;
  /** Pass `value` through every `modify[name]` of the game and the modules, in order. */
  modify<T, Name extends keyof M & string = keyof M & string>(name: Name, value: T, data?: M[Name]): T;
  /** Fire `event` after `seconds` of world time (pauses stop it). Returns the timer key. */
  after<Name extends keyof E & string>(seconds: number, event: Name, data?: E[Name], options?: { key?: string }): string;
  after(seconds: number, event: PrivateEvent, data?: unknown, options?: { key?: string }): string;
  /** Fire `event` every `seconds` (first after `seconds`). Same key + event + interval → the running timer is kept. */
  every<Name extends keyof E & string>(seconds: number, event: Name, data?: E[Name], options?: Omit<TimerOptions, 'every'>): string;
  every(seconds: number, event: PrivateEvent, data?: unknown, options?: Omit<TimerOptions, 'every'>): string;
  /** Cancel a timer by key; with `prefix: true` every timer whose key starts with it. Returns how many. */
  cancel(key: string, options?: { prefix?: boolean }): number;
  /** Seconds until the timer with this key fires, or undefined. */
  timeLeft(key: string): number | undefined;
  /** Live timers whose key starts with `prefix` (all when empty). */
  timers(prefix?: string): number;
  /**
   * Run code owned by a module: an exception disables that module (reported in the feed and
   * `/health`) instead of pausing the game; returns undefined when it failed or is disabled.
   * Owner `game` pauses the game as usual. Use it when calling definition hooks.
   */
  isolate<T>(owner: string, run: () => T): T | undefined;
  /** Whether a module is currently disabled after an error (until the next code load). */
  disabled(owner: string): boolean;
  /** Message visible to everyone in the world feed. */
  log(text: string): void;
  /** Private toast for one player. */
  notify(playerId: string, text: string): void;
  /** Fresh id for entities/effects (monotonic, persisted). */
  nextId(): number;
  random(): number;
  isHost(playerId: string): boolean;
  /** Removes a player and closes their connections. */
  removePlayer(playerId: string): void;
  /** Ask for a checkpoint soon (the engine also saves every ~2 s while time moves). */
  save(): void;
  /**
   * One-off message to clients — everyone, or one player: sounds, screen shake, toasts.
   * Not stored in the world — clients that join later never see it. Batched per tick.
   * (Game logic that should react to something uses `trigger` instead.)
   */
  emit(name: string, data?: unknown, playerId?: string): void;
  /**
   * Apply the result of asynchronous work (a worker pool, fetch, …) on a later tick,
   * inside the simulation. Pending jobs are dropped by a hot reload, so keep the
   * request itself in the world if it must survive (e.g. `enemy.data.pathRequested`).
   */
  job<T>(work: Promise<T>, apply: (world: W, result: T, ctx: GameContext<W, E>) => void, fail?: (world: W, error: Error, ctx: GameContext<W, E>) => void): void;
  /** Case-insensitive name lookup (exact, then unique prefix). */
  findPlayer(nameOrId: string): PlayerOf<W> | undefined;
  /**
   * Add a server-controlled player (needs `GameDefinition.bot`). It is created with
   * `createPlayer`, counts as online, never uses a seat and is driven by `bot()` every tick.
   */
  addBot(name?: string): string;
  isBot(playerId: string): boolean;
  /** Run `GameDefinition.command` as if `playerId` sent it (bots, scripted events, admin tools). */
  command(playerId: string, command: { type: string; [key: string]: unknown }): string | void;
}

export interface ChatCommand<W extends BaseWorld> {
  description: string;
  /** Usage hint shown by /help, e.g. "<nick> <text>". */
  usage?: string;
  /** Only the host may use it. */
  host?: boolean;
  /** Return a string to answer the author privately. */
  run(world: W, playerId: string, args: string, ctx: GameContext<W>): string | void;
}

export interface AdminCommand<W extends BaseWorld> {
  description: string;
  /** Called by `gaime admin <name> [args…]`; the return value is printed as JSON. */
  run(world: W, args: string[], ctx: GameContext<W>): unknown;
}

export type RequestHandler<W extends BaseWorld> = (world: W, playerId: string, payload: unknown, ctx: GameContext<W>) => unknown | Promise<unknown>;

export interface GameDefinition<W extends BaseWorld, I = unknown, S = any, E extends EventMap = EventMap, M extends ModifierMap = ModifierMap> extends Behaviour<S, E, M> {
  /** Room name, checkpoint name and browser storage prefix. Lowercase, stable. */
  name: string;
  /** Maximum players online at once. Default: unlimited. */
  maxPlayers?: number;
  /**
   * `true` (default): a player's character stays in the world after leaving and returns
   * with the same browser identity. `false`: leaving frees the seat (duels, board games).
   */
  keepPlayers?: boolean;
  /** Simulation ticks per second. Default 30. */
  tickRate?: number;
  /** Publish a network patch every N ticks. Default 2 (15 Hz at 30 ticks). */
  publishEvery?: number;
  /** Seconds a dropped connection keeps its seat. Default 30. */
  reconnectSeconds?: number;
  /** Input older than this is dropped (player stops). Default 400 ms. */
  inputLeaseMs?: number;
  /** Messages per second one client may send before being disconnected. Default 90. */
  maxMessagesPerSecond?: number;
  network?: NetworkConfig;

  createWorld(): W;
  /**
   * Upgrade an older world (checkpoint or HMR cache) in place and return it.
   * Missing fields are already filled from `createWorld()` / `createPlayer()`.
   * Throw to refuse an incompatible save — it is never deleted automatically.
   */
  migrate?(world: W): W;
  /** Called after load, after every hot reload and on first start (e.g. refresh the catalog). */
  prepare?(world: W, ctx: GameContext<W, E, M>): void;

  createPlayer(world: W, id: string, name: string, ctx: GameContext<W, E, M>): PlayerOf<W>;
  onPlayerOnline?(world: W, player: PlayerOf<W>, online: boolean, ctx: GameContext<W, E, M>): void;
  /** The player is about to be deleted from the world. */
  onPlayerRemoved?(world: W, player: PlayerOf<W>, ctx: GameContext<W, E, M>): void;

  /**
   * What one player may see: return a copy of `world` without other players' secrets
   * (cards in hand, fog of war). Receives the network projection — never mutate it,
   * return a new object for every key you change: `{ ...world, hands: { [id]: world.hands[id] } }`.
   * Costs one diff per client per publish instead of one shared diff.
   */
  view?(world: W, playerId: string): W;
  /** Validate and normalise raw client input. Return undefined to ignore it. */
  parseInput(raw: unknown): I | undefined;
  /**
   * Advance the simulation by one tick (`dt` = 1 / tickRate seconds). Not called while paused.
   * Runs after the `input` systems and before the `update` systems.
   */
  step?(world: W, inputs: Readonly<Record<string, I>>, dt: number, ctx: GameContext<W, E, M>, sim: S): void;
  /**
   * The module registry: its modules' `on`, `modify`, `systems` and `commands` run in the engine
   * (after the game's own), isolated per module.
   */
  features?: Pick<Registry<any>, 'handlers' | 'modifiers' | 'systems' | 'commands'>;
  /**
   * Builds what handlers, systems and module commands receive (the game's `Sim` facade).
   * Called once per tick and per command. Default: the `GameContext` itself.
   */
  sim?(ctx: GameContext<W, E, M>, dt: number): S;
  /** Discrete player actions. Return a string to send it back to the player as a notice. */
  command?(world: W, playerId: string, command: { type: string; [key: string]: unknown }, ctx: GameContext<W, E, M>): string | void;

  /**
   * Brain of bot players: called every tick for each bot, returns its input (like a client would send).
   * Discrete actions: `ctx.command(botId, {...})`. Enables `/bot` and `/bot remove` in chat (host only).
   */
  bot?(world: W, botId: string, ctx: GameContext<W, E, M>): I | undefined;
  /** RPC: `client.request(name, payload)` resolves with the returned value (or rejects with a thrown error). */
  requests?: Record<string, RequestHandler<W>>;
  /** Chat: extra slash commands (`/name args`) and an optional filter (return null to drop a message). */
  chat?: {
    commands?: Record<string, ChatCommand<W>>;
    filter?(text: string, player: PlayerOf<W>): string | null;
  };
  /** Operator commands for `gaime admin <name>` (require the admin token). */
  admin?: Record<string, AdminCommand<W>>;
  /** Extra HTTP routes on the game server. Registered once: changes need a restart. */
  routes?(app: Application): void;
}

export function defineGame<W extends BaseWorld, I, S = any, E extends EventMap = EventMap, M extends ModifierMap = ModifierMap>(game: GameDefinition<W, I, S, E, M>): GameDefinition<W, I, S, E, M> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(game.name)) throw new Error(`Invalid game name "${game.name}" (lowercase letters, digits, dashes).`);
  return game;
}
