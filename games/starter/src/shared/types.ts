import type { BasePlayer, BaseWorld, CatalogEntry, FeatureModule, Visual } from '@gaime/core';

// ── World (serialisable, synchronised to every client, stored in checkpoints) ──

export interface Player extends BasePlayer {
  x: number;
  z: number;
  /** Facing / aim direction around Y (radians, 0 = +Z). */
  angle: number;
  hp: number;
  maxHp: number;
  color: string;
  /** Seconds of world time until respawn; 0 = alive. */
  respawnAt: number;
  kills: number;
  /** Ability ids bound to Q and E. */
  abilities: [string, string];
  /** Ability id → world time when it is ready again. */
  cooldowns: Record<string, number>;
  nextShotAt: number;
}

export interface Enemy {
  id: string;
  /** EnemyDef id from a feature. */
  kind: string;
  x: number;
  z: number;
  angle: number;
  hp: number;
  maxHp: number;
  /** Free-form state for `EnemyDef.tick`. Prefix keys with your feature id. */
  data: Record<string, number | string | boolean>;
}

export type EffectType = 'tracer' | 'pulse' | 'hit' | 'text' | 'spawn';

/** Short-lived visual event. Immutable once emitted; the client animates it by age. */
export interface Effect {
  id: number;
  type: EffectType;
  time: number;
  x: number;
  z: number;
  /** End point for tracers. */
  x2?: number;
  z2?: number;
  radius?: number;
  color?: string;
  text?: string;
}

export interface Spawn {
  id: number;
  enemy: string;
  at: number;
  x: number;
  z: number;
}

export type Phase = 'lobby' | 'fight' | 'break' | 'lost';

export interface World extends BaseWorld<Player> {
  phase: Phase;
  wave: number;
  /** World time when the break ends and the next wave begins. */
  nextWaveAt: number;
  /** Name of the running wave (WaveDef.name). */
  waveName: string;
  crystal: { hp: number; maxHp: number };
  score: number;
  enemies: Record<string, Enemy>;
  spawns: Spawn[];
  effects: Effect[];
  /** Serialisable catalog of every feature definition, rebuilt from the registry on load. */
  catalog: CatalogEntry[];
}

// ── Client → server ──

export interface Input {
  /** Movement direction, each axis -1..1 (camera-independent world axes). */
  mx: number;
  mz: number;
  /** Aim point on the ground. */
  ax: number;
  az: number;
  fire: boolean;
}

export type Command =
  | { type: 'start' }
  | { type: 'restart' }
  | { type: 'cast'; slot: 0 | 1; x: number; z: number }
  | { type: 'equip'; slot: 0 | 1; ability: string };

// ── Feature API (server only: definitions may contain functions) ──

/** Engine services for feature code. Everything here is safe to call from ticks and casts. */
export interface Sim {
  readonly world: World;
  readonly dt: number;
  random(): number;
  enemies(): Enemy[];
  /** Players that are online and alive. */
  players(): Player[];
  nearestEnemy(from: { x: number; z: number }, range?: number): Enemy | undefined;
  nearestPlayer(from: { x: number; z: number }, range?: number): Player | undefined;
  hurtEnemy(enemy: Enemy, amount: number, byPlayerId?: string): void;
  hurtPlayer(player: Player, amount: number): void;
  hurtCrystal(amount: number): void;
  heal(player: Player, amount: number): void;
  /** Queue enemies. Default position: random point on the arena edge. */
  spawn(enemy: string, options?: { count?: number; delay?: number; interval?: number; x?: number; z?: number }): void;
  /** Slow an enemy to `factor` of its speed for `seconds` (the strongest active slow wins). */
  slow(enemy: Enemy, factor: number, seconds: number): void;
  /** Move an entity towards a point (respects slows). Returns the remaining distance. */
  moveTowards(entity: { x: number; z: number; angle: number }, target: { x: number; z: number }, speed: number): number;
  effect(type: EffectType, at: { x: number; z: number }, options?: Partial<Omit<Effect, 'id' | 'type' | 'time' | 'x' | 'z'>>): void;
  log(text: string): void;
  /** One-off client event (sounds, shakes). `playerId` limits it to one player. */
  emit(name: string, data?: unknown, playerId?: string): void;
  enemyDef(kind: string): EnemyDef | undefined;
  /** Built-in enemy behaviour with the enemy's own stats — call it from a custom `tick` to extend it. */
  defaultAi(enemy: Enemy): void;
}

export interface EnemyDef {
  id: string;
  name: string;
  description: string;
  hp: number;
  /** Units per second. */
  speed: number;
  /** Collision radius. */
  radius: number;
  /** Contact damage per second to players and the crystal. */
  damage: number;
  /** Score for the kill. */
  reward: number;
  visual: Visual;
  /** Replaces the default AI (walk to the closest target, hurt it on contact). */
  tick?(sim: Sim, enemy: Enemy): void;
  /** Called once when the enemy dies. */
  onDeath?(sim: Sim, enemy: Enemy, byPlayerId?: string): void;
}

export interface AbilityDef {
  id: string;
  name: string;
  description: string;
  /** Seconds. */
  cooldown: number;
  color: string;
  /** Short glyph shown on the button. */
  icon?: string;
  cast(sim: Sim, player: Player, target: { x: number; z: number }): void;
}

export interface WaveDef {
  id: string;
  name: string;
  description: string;
  /** First wave number this attack may appear in. Default 1. */
  minWave?: number;
  /** Relative chance among eligible waves. Default 1. */
  weight?: number;
  /** Queue the enemies of wave number `wave` with `sim.spawn`. */
  start(sim: Sim, wave: number): void;
}

export type Kinds = { enemies: EnemyDef; abilities: AbilityDef; waves: WaveDef };

/** Default export of `src/features/<id>/server.ts`. */
export type Feature = FeatureModule<Kinds>;
