import { clampToRect, moveTopDown } from '@gaime/core/kit';
import type { Input } from './types';

export const RULES = {
  /** The playing field is a square from -size/2 to +size/2 on x and z. */
  size: 40,
  speed: 8,
  playerRadius: 0.5,
  pickupRadius: 0.6,
  maxPickups: 12,
  spawnEvery: 1.5,
  /** Seconds a pickup stays before it disappears. */
  pickupLife: 20,
};

export const FIELD = { x: -RULES.size / 2, z: -RULES.size / 2, width: RULES.size, depth: RULES.size };

/** Shared by the server (authority) and the client (prediction). */
export function movePlayer(player: { x: number; z: number }, input: Input, dt: number) {
  moveTopDown(player, input, RULES.speed, dt);
  clampToRect(player, FIELD, RULES.playerRadius);
}
