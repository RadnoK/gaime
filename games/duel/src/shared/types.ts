import type { BasePlayer, BaseWorld, CatalogEntry, FeatureModule } from '@gaime/core';
import type { Effect, MatchState, Projectile, TurnState } from '@gaime/core/kit';

export type { Effect, Projectile };

/**
 * Side view: the simulation plane is x (right) / z (up). The renderer maps z to the
 * screen's vertical axis. Terrain is a height field sampled every RULES.step units.
 */

// ── World ──

export interface Player extends BasePlayer {
  /** 0 = left, 1 = right, -1 = spectator. */
  seat: -1 | 0 | 1;
  x: number;
  z: number;
  vz: number;
  facing: 1 | -1;
  /** Aim in degrees: 0 = right, 90 = straight up, 180 = left. */
  aim: number;
  hp: number;
  wins: number;
  /** Selected WeaponDef id. */
  weapon: string;
  /** Shots left this round for weapons with limited ammo. */
  ammo: Record<string, number>;
}

export interface World extends BaseWorld<Player> {
  match: MatchState;
  turns: TurnState | null;
  /** Heights of the terrain, one sample every RULES.step units from -RULES.width / 2. */
  terrain: number[];
  /** Horizontal acceleration applied to projectiles (units/s², + = right). Rerolled every turn. */
  wind: number;
  projectiles: Record<string, Projectile>;
  effects: Effect[];
  /** The active player has fired this turn. */
  shotFired: boolean;
  /** After the shot resolves the shooter may still move until this time. */
  retreatUntil: number;
  catalog: CatalogEntry[];
}

// ── Client → server ──

export interface Input {
  /** Walk -1..1 (only on your turn). */
  move: number;
  /** Aim angle in degrees (0..180). */
  aim: number;
}

export type Command =
  | { type: 'ready' }
  | { type: 'fire'; power: number }
  | { type: 'weapon'; id: string };

// ── Modules ──

/** Engine services for weapon code. */
export interface Sim {
  readonly world: World;
  random(): number;
  /** Crater + damage with falloff to every player within `radius`. */
  explode(at: { x: number; z: number }, radius: number, damage: number, byPlayerId: string): void;
  /** Launch an extra projectile (cluster bomblets, bouncing shots). */
  launch(weapon: string, from: { x: number; z: number }, angleDegrees: number, speed: number, owner: string): void;
  heightAt(x: number): number;
  log(text: string): void;
  emit(name: string, data?: unknown): void;
}

export interface WeaponDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  /** Launch speed at full power. */
  speed: number;
  damage: number;
  /** Explosion radius (also the crater size). */
  radius: number;
  /** Shots per round; omit for unlimited. */
  ammo?: number;
  /** How much the wind pushes it (0 = not at all). Default 1. */
  wind?: number;
  /** Gravity multiplier. Default 1. */
  gravity?: number;
  /** Projectiles per shot, fanned out by `spread` degrees. */
  count?: number;
  spread?: number;
  /** Not offered in the weapon bar (e.g. bomblets spawned by another weapon). */
  hidden?: boolean;
  /** Replaces the default explosion on impact. */
  onImpact?(sim: Sim, projectile: Projectile, at: { x: number; z: number }): void;
}

export type Kinds = { weapons: WeaponDef };
export type Feature = FeatureModule<Kinds>;
