import type { Schedule } from './schedule';

/** Values allowed in free-form `data` bags. Keep them flat so checkpoints and patches stay trivial. */
export type Scalar = number | string | boolean;
export type Data = Record<string, Scalar>;

export interface BasePlayer {
  id: string;
  name: string;
  online: boolean;
  /** Free-form per-player state for features. Prefix keys with the feature id. */
  data: Data;
}

export interface FeedItem {
  id: number;
  time: number;
  text: string;
  /** Player who wrote a chat message; absent for system messages. */
  from?: string;
  /** `chat` (default when `from` is set), `me` (/me action) or `system`. */
  kind?: 'chat' | 'me' | 'system';
}

export interface Pause {
  reason: 'host' | 'error';
  message?: string;
}

/**
 * Every game world extends this. The engine owns these fields:
 * `version`, `time` (seconds, advances only when not paused), `tick`, `pause`, `hostId`,
 * `feed`, `seq` and `schedule`.
 */
export interface BaseWorld<P extends BasePlayer = BasePlayer> {
  schema: number;
  version: string;
  /** Simulation time in seconds: the one clock for every rule, timer and cooldown. */
  time: number;
  /** Simulation steps since the world was created (each is exactly 1 / tickRate seconds). */
  tick: number;
  pause: Pause | null;
  hostId: string | null;
  players: Record<string, P>;
  feed: FeedItem[];
  /** Monotonic id source for entities and effects: use `ctx.nextId()`. */
  seq: number;
  /** Engine timers (`ctx.after`, `ctx.every`). Server-only: never sent to clients. */
  schedule: Schedule;
}

export type PlayerOf<W extends BaseWorld> = W['players'][string];

export interface Welcome {
  id: string;
  game: string;
  version: string;
  protocol: number;
  revision: number;
  host: boolean;
}

export interface Health {
  ok: boolean;
  game: string;
  /** Version of the server code that is actually loaded (changes after HMR). */
  version: string;
  error: string | null;
  /** Modules switched off after an error (module id → message), until the next code load. */
  disabled?: Record<string, string>;
  uptime: number;
}

/**
 * Serialisable look of an entity, chosen on the server and drawn by the client.
 * Built-in shapes: box, sphere, capsule, cone, cylinder, torus, octahedron, ring.
 * Any other `shape` name resolves to a model registered by a feature's `client.ts`.
 */
export interface Visual {
  shape: string;
  color?: string;
  emissive?: string;
  /** Uniform scale or [x, y, z]. Purely visual: collision radius stays in game data. */
  scale?: number | [number, number, number];
  /** Lift above the ground in world units. */
  lift?: number;
}

/**
 * WebSocket close codes the client treats as final (no automatic reconnect).
 * Colyseus owns 4000–4010 (4002 = error, 4003 = failed reconnect), so stay clear of them.
 */
export const CLOSE_REMOVED = 4102;
export const CLOSE_REPLACED = 4103;
