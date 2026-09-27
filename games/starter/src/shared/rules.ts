import { clampToCircle, keepOutOfCircle, moveTopDown } from '@gaime/core/kit';
import type { Input } from './types';

/** Balance and geometry shared by the server simulation and client prediction. */
export const RULES = {
  arenaRadius: 30,
  crystalRadius: 2.2,
  crystalHp: 1000,
  playerRadius: 0.5,
  playerSpeed: 6.5,
  playerHp: 100,
  respawnSeconds: 5,
  shotInterval: 0.16,
  shotRange: 22,
  shotDamage: 12,
  breakSeconds: 8,
  effectSeconds: 1.2,
  defaultAbilities: ['dash', 'pulse'] as [string, string],
  palette: ['#59e3ff', '#ff7a59', '#b0ff59', '#ff59d6', '#ffd659', '#8f7bff', '#59ffb0', '#ff5977'],
};

const CENTER = { x: 0, z: 0 };

/** Keeps a point inside the arena and outside the crystal. */
export function clampToArena(point: { x: number; z: number }, radius = RULES.playerRadius) {
  clampToCircle(point, RULES.arenaRadius, radius);
  keepOutOfCircle(point, CENTER, RULES.crystalRadius + radius);
}

/** Player movement; the client runs the same function to predict its own character. */
export function movePlayer(player: { x: number; z: number; angle: number }, input: Input, dt: number) {
  moveTopDown(player, input, RULES.playerSpeed, dt);
  clampToArena(player);
  const dx = input.ax - player.x;
  const dz = input.az - player.z;
  if (Math.hypot(dx, dz) > 0.2) player.angle = Math.atan2(dx, dz);
}
