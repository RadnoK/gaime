import type { BasePlayer, BaseWorld, CatalogEntry, FeatureModule } from '@gaime/core';
import type { Effect, MatchState, Projectile, TurnState } from '@gaime/core/kit';

export type { Effect, Projectile };

/**
 * Side view: the simulation plane is x (right) / z (up). The renderer maps z to the
 * screen's vertical axis. Terrain is a height field sampled every RULES.step units.
 */

// ── World: plain JSON, synchronised to clients and saved in checkpoints ──

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

/**
 * Where the active player is within their turn:
 * `aim` (walk, aim, fire once) → `flight` (shells in the air, turn clock frozen)
 * → `retreat` (every shell landed; the shooter may walk for RULES.retreatSeconds) → next turn.
 */
export type TurnPhase = 'aim' | 'flight' | 'retreat';

export interface World extends BaseWorld<Player> {
  match: MatchState;
  /**
   * Turn order and the displayed turn clock (`turnTimeLeft`). The end of a turn itself is
   * a timer keyed `turn:end` that fires `turn.expired`.
   */
  turns: TurnState | null;
  turnPhase: TurnPhase;
  /** Heights of the terrain, one sample every RULES.step units from -RULES.width / 2. */
  terrain: number[];
  /** Horizontal acceleration applied to projectiles (units/s², + = right). Rerolled every turn. */
  wind: number;
  projectiles: Record<string, Projectile>;
  effects: Effect[];
  /** Rebuilt from the registry on load; never saved. */
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

// ── Events: the game's bus (ctx.trigger / `on` handlers). Payloads are plain JSON. ──

export type Events = {
  /** Both seated players are ready; the round starts in `seconds`. */
  'match.countdown': { seconds: number };
  /** A round began: fresh terrain, full HP, ammo refilled. */
  'match.started': { round: number; players: string[] };
  /** A round ended (`winner` null = draw or aborted). */
  'match.ended': { round: number; winner: string | null; reason: string };
  /** A player's turn began; `wind` already went through the `wind.strength` modifiers. */
  'turn.started': { player: string; turn: number; wind: number };
  /** Timer `turn:end`: the turn's time (or the retreat after a shot) ran out. Stale turns are ignored. */
  'turn.expired': { turn: number };
  /** Every shell of the turn has landed; the shooter may retreat. */
  'turn.resolved': { player: string; turn: number };
  /** The active player fired (one event per shot, however many shells it launches). */
  'shell.fired': { player: string; weapon: string; power: number };
  /**
   * A shell touched the ground or a player (`target`). The game's handler explodes it
   * (or runs `WeaponDef.onImpact`); modules react by weapon. The shell is already gone:
   * its last velocity and `data` are copied here.
   */
  'shell.impact': { shell: string; weapon: string; owner: string; x: number; z: number; vx: number; vz: number; target: string | null; data: Projectile['data'] };
  /** A crater was blown (`sim.explode`): clients play the boom. */
  'shell.exploded': { x: number; z: number; radius: number; by: string; weapon: string };
  /** A player took damage; `damage` already went through the `shell.damage` modifiers. */
  'player.hit': { player: string; by: string; weapon: string; damage: number };
  /** A player's HP reached 0, or they fell into the abyss. */
  'player.died': { player: string; by: string | null; cause: 'shell' | 'fall' };
};

/** Values modules can adjust with `modify`: name → the data passed along. */
export type Modifiers = {
  /** Damage one explosion does to one player, after the distance falloff. */
  'shell.damage': { player: string; by: string; weapon: string; distance: number };
  /** Explosion and crater radius of a weapon's default explosion. */
  'shell.radius': { weapon: string; owner: string };
  /** The wind rolled for a turn (units/s², + = right). Rounded to 0.5 afterwards. */
  'wind.strength': { player: string; turn: number };
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
  /** Cancel a timer by key, or every timer whose key starts with `key` (`prefix`). */
  cancel(key: string, prefix?: boolean): void;
  modify<K extends keyof Modifiers>(name: K, value: number, data: Modifiers[K]): number;
  /** Feed message for everyone. */
  log(text: string): void;
  /** One-off client event for pure presentation (facts go through `trigger` + `network.events`). */
  emit(name: string, data?: unknown, playerId?: string): void;
  /** Run code owned by a module: an error switches that module off instead of pausing the game. */
  isolate<T>(module: string, run: () => T): T | undefined;
  /** The two seated players, left first. */
  fighters(): Player[];
  heightAt(x: number): number;
  /**
   * Crater + damage with falloff to every player within `radius` (through `shell.damage`);
   * triggers `shell.exploded`, `player.hit`, `player.died`.
   */
  explode(at: { x: number; z: number }, radius: number, damage: number, byPlayerId: string, weapon?: string): void;
  /** Launch an extra projectile (cluster bomblets, bouncing shots). Angle in degrees from +X. */
  launch(weapon: string, from: { x: number; z: number }, angleDegrees: number, speed: number, owner: string): Projectile;
}

export type Impact = Events['shell.impact'];

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
  /**
   * Replaces the default explosion on impact. Runs isolated: if it throws, its module is
   * switched off and the shell explodes normally. To add to the default explosion instead,
   * use `on: { 'shell.impact': … }` filtered by `weapon`.
   */
  onImpact?(sim: Sim, impact: Impact): void;
}

export type Kinds = { weapons: WeaponDef };
/** Default export of `src/features/<id>/server.ts`: definitions plus optional `on`, `modify`, `systems`, `commands`. */
export type Feature = FeatureModule<Kinds, Sim, Events, Modifiers>;
