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
  /** Server-side schedules for `every`/`schedule` from @gaime/core/kit. */
  timers: Record<string, number>;
  /** Rebuilt from the registry on load; never saved. */
  catalog: CatalogEntry[];
}

// ── Client → server ──

export interface Input {
  mx: number;
  mz: number;
}

export type Command = { type: 'reset-scores' };

// ── Modules: src/features/<id>/server.ts ──

export interface PickupDef {
  id: string;
  name: string;
  description: string;
  /** Points for collecting it. */
  value: number;
  /** Relative spawn chance. */
  weight: number;
  visual: Visual;
  /** Extra effect when collected (optional). */
  onPickup?(world: World, player: Player): void;
}

export type Kinds = { pickups: PickupDef };
export type Feature = FeatureModule<Kinds>;
