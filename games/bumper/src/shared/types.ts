import type { BasePlayer, BaseWorld, CatalogEntry, FeatureModule, Visual } from '@gaime/core';
import type { MatchState } from '@gaime/core/kit';
import type { Body, PhysicsContact } from '@gaime/physics';

// ── World: plain JSON, synchronised to clients and saved in checkpoints ──

/**
 * A disc on the arena. `x, z, vx, vz, angle, spin` belong to the physics (`@gaime/physics`):
 * the physics step writes them every tick; game code may change them (a teleport, a push)
 * and the next step picks the change up.
 */
export interface Player extends BasePlayer, Body {
  color: string;
  /** Rounds won. */
  wins: number;
  /** On the arena. False: knocked out this round (or joined mid-round) — no physics body. */
  alive: boolean;
  /** `world.time` of the last knockout (the client animates the fall). */
  outAt: number;
  /** Density of the disc after the `push.mass` modifiers (1 = normal): heavier discs push harder. */
  mass: number;
}

/** A powerup lying on the arena. */
export interface Pickup {
  id: string;
  /** PowerupDef id. */
  kind: string;
  x: number;
  z: number;
}

export interface World extends BaseWorld<Player> {
  /** lobby → countdown → playing → ended (kit `createMatch` / `stepMatch`). */
  match: MatchState;
  /** Current arena radius: shrinks late in a round so every round ends. */
  arena: number;
  pickups: Record<string, Pickup>;
  /** Rebuilt from the registry on load; never saved. */
  catalog: CatalogEntry[];
}

// ── Client → server ──

export interface Input {
  /** Steering -1..1 on x and z (screen up = -z). */
  mx: number;
  mz: number;
}

export type Command =
  | { type: 'ready' }
  /** Dash in a direction (normalised by the server); without one, along the current velocity. */
  | { type: 'dash'; x?: number; z?: number };

// ── Events: the game's bus (ctx.trigger / `on` handlers). Payloads are plain JSON. ──

export type Events = {
  /** Two colliders started or stopped touching (from `@gaime/physics`, every tick). */
  'physics.contact': PhysicsContact;
  /** Two discs collided hard enough to hear (`speed` = relative speed). */
  'player.bumped': { a: string; b: string; speed: number };
  /** A disc left the arena. `by`: the last player who touched it within RULES.creditSeconds. */
  'player.knocked': { player: string; by: string | null };
  /** Timer `player:<id>:respawn` (outside rounds): the disc comes back. */
  'player.respawn': { player: string };
  /** A player dashed; `power` already went through the `dash.power` modifiers. */
  'dash.used': { player: string; power: number };
  /** Everyone is ready; the round starts in `seconds`. */
  'round.countdown': { seconds: number };
  /** A round began: every present player was placed on the arena. */
  'round.started': { round: number; players: string[] };
  /** A round ended; `player` null = a draw (time ran out, or the last two fell together). */
  'round.won': { round: number; player: string | null };
  /** A powerup appeared on the arena. */
  'pickup.spawned': { pickup: string; kind: string };
  /** A player rolled over a powerup (its effect is already applied). */
  'pickup.collected': { player: string; pickup: string; kind: string };
};

/** Values modules can adjust with `modify`: name → the data passed along. */
export type Modifiers = {
  /** Velocity a dash adds (units/s). */
  'dash.power': { player: string };
  /** Density of a player's disc (1 = normal). Heavier discs push harder and are harder to push. */
  'push.mass': { player: string };
  /** Steering acceleration (units/s²). */
  'move.accel': { player: string };
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
  /** A derived value that is not saved (the physics world lives here). */
  resource<T>(key: string, create: () => T, options?: ((value: T) => void) | { dispose?(value: T): void; save?(value: T): unknown; load?(data: unknown): T }): T;
  /** Stop (or allow again) matchmaking into this room — locked while a round runs. */
  lockRoom(locked: boolean): void;
  /** Players still on the arena. */
  fighters(): Player[];
  /** Push a disc: `impulse` = mass × Δv, so heavy discs move less. */
  push(playerId: string, impulse: { x: number; z: number }): void;
  /** Knock a player out (as if they fell off the edge). */
  knockOut(playerId: string, by?: string | null): void;
  /** Place a powerup (random kind and position by default). */
  spawnPickup(kind?: string, at?: { x: number; z: number }): Pickup | undefined;
}

export interface PowerupDef {
  id: string;
  name: string;
  description: string;
  /** Relative spawn chance. */
  weight: number;
  /** Seconds the effect lasts: the player gets the status `powerup:<id>` (kit `status` in `player.data`). */
  duration: number;
  visual: Visual;
  /** Extra effect when collected (optional); runs isolated. */
  onCollect?(sim: Sim, player: Player, pickup: Pickup): void;
}

export type Kinds = { powerups: PowerupDef };
/** Default export of `src/features/<id>/server.ts`: definitions plus optional `on`, `modify`, `systems`, `commands`. */
export type Feature = FeatureModule<Kinds, Sim, Events, Modifiers>;
