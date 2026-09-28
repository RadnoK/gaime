import type { BasePlayer, BaseWorld, CatalogEntry, FeatureModule, Visual } from '@gaime/core';
import type { Effect, EffectType } from '@gaime/core/kit';

export type { Effect, EffectType };

// ── World (serialisable, synchronised to every client, stored in checkpoints) ──

export interface Player extends BasePlayer {
  x: number;
  z: number;
  /** Facing / aim direction around Y (radians, 0 = +Z). */
  angle: number;
  hp: number;
  maxHp: number;
  color: string;
  /** World time of the respawn while down (the `player:<id>:respawn` timer does it); 0 = alive. */
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

export type Phase = 'lobby' | 'fight' | 'break' | 'lost';

export interface World extends BaseWorld<Player> {
  phase: Phase;
  wave: number;
  /** World time when the break ends (the `wave:next` timer starts the wave; the HUD shows the countdown). */
  nextWaveAt: number;
  /** Name of the running wave (WaveDef.name). */
  waveName: string;
  crystal: { hp: number; maxHp: number };
  score: number;
  /** Living enemies. Enemies still to come are timers keyed `spawn:<n>` in `world.schedule`. */
  enemies: Record<string, Enemy>;
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

// ── Events: the game's bus (ctx.trigger / `on` handlers). Payloads are plain JSON (ids, not objects). ──

export type Events = {
  /** Timer (`sim.spawn`, key `spawn:<n>`): an enemy enters the arena now. */
  'enemy.spawn': { id: string; kind: string; x: number; z: number };
  'enemy.spawned': { enemy: string; kind: string; x: number; z: number };
  /** `by` = the killing player; `reward` already went through the `enemy.reward` modifiers. */
  'enemy.died': { enemy: string; kind: string; by?: string; x: number; z: number; reward: number };
  'player.downed': { playerId: string; x: number; z: number };
  /** Timer (key `player:<id>:respawn`). */
  'player.respawn': { playerId: string };
  'player.respawned': { playerId: string };
  /** A player used an ability (after the cooldown check). */
  'ability.cast': { playerId: string; ability: string; x: number; z: number };
  /** Timer (key `wave:next`): the break is over. */
  'wave.start': { wave: number };
  'wave.started': { wave: number; attack: string; name: string };
  'wave.cleared': { wave: number; bonus: number };
  'round.lost': { wave: number; score: number };
};

/** Values modules can adjust with `modify`: name → the data passed along. */
export type Modifiers = {
  /** Units per second an enemy moves (slows, hastes). */
  'enemy.speed': { enemy: string; kind: string };
  /** Max HP of an enemy entering on wave `wave` (the value already includes the wave scaling). */
  'enemy.hp': { kind: string; wave: number };
  /** Damage an enemy takes. `source`: 'shot', an ability id, or whatever the caller passed. */
  'enemy.damage': { enemy: string; kind: string; by?: string; source: string };
  /** Score for a kill. */
  'enemy.reward': { enemy: string; kind: string; by?: string };
  /** Damage a player takes. `source`: the enemy kind, or what the caller passed. */
  'player.damage': { playerId: string; source: string };
  /** Damage the crystal takes. */
  'crystal.damage': { source: string };
  /** Cooldown (seconds) of an ability just cast. */
  'ability.cooldown': { playerId: string; ability: string };
};

// ── Feature API (server only: definitions may contain functions) ──

/**
 * What module code receives (`on` handlers, `modify`, `systems`, `commands`, definition hooks):
 * the world plus the helpers that keep the rules in one place (damage → death → event).
 */
export interface Sim {
  readonly world: World;
  /** Seconds since the last run (a tick, or the interval of a periodic system; 0 in commands). */
  readonly dt: number;
  random(): number;
  /** Put an event on the bus; handlers run right after the current code, in the same tick. */
  trigger<K extends keyof Events>(event: K, data: Events[K]): void;
  /** A module's private event `<module>:<event>` (no entry in Events needed). */
  trigger(event: `${string}:${string}`, data?: unknown): void;
  /** Fire an event after `seconds` of game time (saved with the world; the same `key` replaces the timer). */
  after<K extends keyof Events>(seconds: number, event: K, data: Events[K], options?: { key?: string }): void;
  after(seconds: number, event: `${string}:${string}`, data?: unknown, options?: { key?: string }): void;
  /** Cancel a timer by key, or every timer whose key starts with `key` (`prefix: true`). Returns how many. */
  cancel(key: string, options?: { prefix?: boolean }): number;
  /** Seconds until the timer with this key fires, or undefined. */
  timeLeft(key: string): number | undefined;
  /** Live timers whose key starts with `prefix`, e.g. `timers('spawn:')` = enemies still to come. */
  timers(prefix?: string): number;
  /** Pass a value through every `modify[name]` of the game and the modules. */
  modify<K extends keyof Modifiers>(name: K, value: number, data: Modifiers[K]): number;
  /** Run code owned by a module: an error switches that module off instead of pausing the game. */
  isolate<T>(module: string, run: () => T): T | undefined;
  /** Whether a module is switched off after an error (until the next code load). */
  disabled(module: string): boolean;
  enemies(): Enemy[];
  /** Players that are online and alive. */
  players(): Player[];
  nearestEnemy(from: { x: number; z: number }, range?: number): Enemy | undefined;
  nearestPlayer(from: { x: number; z: number }, range?: number): Player | undefined;
  /** Enemies within `radius` (the engine's spatial index; exact distance). */
  enemiesNear(at: { x: number; z: number }, radius: number): Enemy[];
  /** Damage through `enemy.damage`; a kill scores (`enemy.reward`), calls `onDeath` and triggers `enemy.died`. */
  hurtEnemy(enemy: Enemy, amount: number, byPlayerId?: string, source?: string): void;
  /** Damage through `player.damage`; at 0 HP the player is down (`player.downed`) and respawns by a timer. */
  hurtPlayer(player: Player, amount: number, source?: string): void;
  hurtCrystal(amount: number, source?: string): void;
  heal(player: Player, amount: number): void;
  /** Schedule enemies (timers `spawn:<n>`). Default position: random point on the arena edge. */
  spawn(enemy: string, options?: { count?: number; delay?: number; interval?: number; x?: number; z?: number }): void;
  /** Slow an enemy to `factor` of its speed for `seconds` (the strongest active slow wins). */
  slow(enemy: Enemy, factor: number, seconds: number): void;
  /** An enemy's current speed: its definition's `speed` through the `enemy.speed` modifiers (slows included). */
  enemySpeed(enemy: Enemy): number;
  /** Move an entity towards a point at `speed` (units/s). Returns the remaining distance. */
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
  /** Replaces the default AI (walk to the closest target, hurt it on contact). If the module is switched off, the default AI runs. */
  tick?(sim: Sim, enemy: Enemy): void;
  /** Called once when the enemy dies (before `enemy.died` is dispatched). */
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
  /** Schedule the enemies of wave number `wave` with `sim.spawn`. */
  start(sim: Sim, wave: number): void;
}

export type Kinds = { enemies: EnemyDef; abilities: AbilityDef; waves: WaveDef };

/** Default export of `src/features/<id>/server.ts`: definitions plus optional `on`, `modify`, `systems`, `commands`. */
export type Feature = FeatureModule<Kinds, Sim, Events, Modifiers>;
