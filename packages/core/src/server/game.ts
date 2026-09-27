import type { Application } from 'express';
import type { BaseWorld, PlayerOf } from '../shared/types';
import type { NetworkConfig } from '../shared/net';

/** Engine services available to game code during `step`, `command` and hooks. */
export interface GameContext<W extends BaseWorld> {
  readonly world: W;
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
   * One-off message to everyone, or to one player: sounds, screen shake, toasts.
   * Not stored in the world — clients that join later never see it.
   */
  emit(name: string, data?: unknown, playerId?: string): void;
  /**
   * Apply the result of asynchronous work (a worker pool, fetch, …) on a later tick,
   * inside the simulation. Pending jobs are dropped by a hot reload, so keep the
   * request itself in the world if it must survive (e.g. `enemy.data.pathRequested`).
   */
  job<T>(work: Promise<T>, apply: (world: W, result: T, ctx: GameContext<W>) => void, fail?: (world: W, error: Error, ctx: GameContext<W>) => void): void;
  /** Case-insensitive name lookup (exact, then unique prefix). */
  findPlayer(nameOrId: string): PlayerOf<W> | undefined;
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

export interface GameDefinition<W extends BaseWorld, I = unknown> {
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
  prepare?(world: W, ctx: GameContext<W>): void;

  createPlayer(world: W, id: string, name: string, ctx: GameContext<W>): PlayerOf<W>;
  onPlayerOnline?(world: W, player: PlayerOf<W>, online: boolean, ctx: GameContext<W>): void;
  /** The player is about to be deleted from the world. */
  onPlayerRemoved?(world: W, player: PlayerOf<W>, ctx: GameContext<W>): void;

  /** Validate and normalise raw client input. Return undefined to ignore it. */
  parseInput(raw: unknown): I | undefined;
  /** Advance the simulation. `dt` in seconds. Not called while paused. */
  step(world: W, inputs: Readonly<Record<string, I>>, dt: number, ctx: GameContext<W>): void;
  /** Discrete player actions. Return a string to send it back to the player as a notice. */
  command?(world: W, playerId: string, command: { type: string; [key: string]: unknown }, ctx: GameContext<W>): string | void;

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

export function defineGame<W extends BaseWorld, I>(game: GameDefinition<W, I>): GameDefinition<W, I> {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(game.name)) throw new Error(`Invalid game name "${game.name}" (lowercase letters, digits, dashes).`);
  return game;
}
