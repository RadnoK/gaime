import { status } from '@gaime/core/kit';
import type { Player } from './types';

export const RULES = {
  /** Arena radius at the start of a round. */
  arena: 11,
  /** The arena starts shrinking this many seconds into a round… */
  shrinkAfter: 25,
  /** …by this much per second, down to `minArena`. */
  shrinkSpeed: 0.35,
  minArena: 3,
  /** A round that lasts this long is a draw. */
  roundSeconds: 120,
  countdownSeconds: 3,
  radius: 0.8,
  /** Steering acceleration (units/s²) and the drag that caps the speed (~accel / damping). */
  accel: 14,
  damping: 1.4,
  restitution: 0.9,
  dash: 11,
  dashCooldown: 1.6,
  /** A disc is out once its centre is this far past the edge. */
  edge: 0.2,
  /** A knockout credits the last player who touched the disc within this many seconds. */
  creditSeconds: 3,
  /** Collisions faster than this are "bumps" (sound, shake). */
  bumpSpeed: 5,
  /** Outside rounds a player who falls off comes back after this many seconds. */
  respawnSeconds: 1.5,
  maxPickups: 3,
  spawnEvery: 5,
  pickupRadius: 0.7,
};

/** Keys in `player.data` (prefixed: modules share the record). */
export const DATA = {
  dash: 'bumper-dash',
  hitBy: 'bumper-hit-by',
  hitAt: 'bumper-hit-at',
};

/** Seconds until the player can dash again (client HUD and bots). */
export const dashLeft = (player: Player, time: number) => Math.max(0, Number(player.data[DATA.dash] ?? 0) - time);

/** Active powerups of a player: `powerup:<id>` statuses (shared so the client can show them). */
export function powerupsOf(player: Player, time: number): string[] {
  return Object.keys(player.data).filter(key => key.startsWith('powerup:') && !key.endsWith(':until') && status.active(player.data, key, time)).map(key => key.slice(8));
}
