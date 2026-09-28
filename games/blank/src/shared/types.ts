import type { BasePlayer, BaseWorld, CatalogEntry, FeatureModule, Visual } from '@gaime/core';

// ── World: plain JSON, synchronised to clients and saved in checkpoints ──

export interface Player extends BasePlayer {
  x: number;
  z: number;
  color: string;
  score: number;
}

export interface Pickup {
  id: string;
  /** PickupDef id. */
  kind: string;
  x: number;
  z: number;
}

export interface World extends BaseWorld<Player> {
  pickups: Record<string, Pickup>;
  /** Rebuilt from the registry on load; never saved. */
  catalog: CatalogEntry[];
}

// ── Client → server ──

export interface Input {
  mx: number;
  mz: number;
}

export type Command = { type: 'reset-scores' };

// ── Events: the game's bus (ctx.trigger / `on` handlers). Payloads are plain JSON. ──

export type Events = {
  /** A pickup appeared on the field. */
  'pickup.spawned': { pickup: string; kind: string };
  /** A player touched a pickup; `points` already went through the `pickup.points` modifiers. */
  'pickup.collected': { playerId: string; pickup: string; kind: string; points: number };
  /** A pickup lay on the field too long (a timer). */
  'pickup.expired': { pickup: string };
};

/** Values modules can adjust with `modify`: name → the data passed along. */
export type Modifiers = {
  /** Points a pickup is worth for this player. */
  'pickup.points': { playerId: string; kind: string };
};

// ── Modules: src/features/<id>/server.ts ──

/** What module code receives (handlers, systems, hooks): the world plus the engine services it may use. */
export interface Sim {
  readonly world: World;
  /** Seconds since the last run (a tick, or the interval of a periodic system). */
  readonly dt: number;
  random(): number;
  /** Put an event on the bus; handlers run right after the current code. */
  trigger<K extends keyof Events>(event: K, data: Events[K]): void;
  /** A module's private event `<module>:<event>` (no entry in Events needed). */
  trigger(event: `${string}:${string}`, data?: unknown): void;
  /** Fire an event after `seconds` of game time (saved with the world; `key` replaces an earlier timer). */
  after<K extends keyof Events>(seconds: number, event: K, data: Events[K], options?: { key?: string }): void;
  after(seconds: number, event: `${string}:${string}`, data?: unknown, options?: { key?: string }): void;
  cancel(key: string): void;
  modify<K extends keyof Modifiers>(name: K, value: number, data: Modifiers[K]): number;
  /** Feed message for everyone. */
  log(text: string): void;
  /** One-off client event (sounds, effects), to everyone or one player. */
  emit(name: string, data?: unknown, playerId?: string): void;
  /** Run code owned by a module: an error switches that module off instead of pausing the game. */
  isolate<T>(module: string, run: () => T): T | undefined;
  /** Place a pickup (random kind and position by default). */
  spawnPickup(kind?: string, at?: { x: number; z: number }): Pickup | undefined;
}

export interface PickupDef {
  id: string;
  name: string;
  description: string;
  /** Points for collecting it. */
  value: number;
  /** Relative spawn chance. */
  weight: number;
  visual: Visual;
  /** Seconds before it disappears. Default RULES.pickupLife. */
  life?: number;
  /** Extra effect when collected (optional). */
  onPickup?(sim: Sim, player: Player, pickup: Pickup): void;
}

export type Kinds = { pickups: PickupDef };
/** Default export of `src/features/<id>/server.ts`: definitions plus optional `on`, `modify`, `systems`, `commands`. */
export type Feature = FeatureModule<Kinds, Sim, Events, Modifiers>;
