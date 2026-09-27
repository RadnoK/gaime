import { clamp } from '@gaime/core';
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

/** Keeps a point inside the arena and outside the crystal. */
export function clampToArena(point: { x: number; z: number }, radius = RULES.playerRadius) {
  const d = Math.hypot(point.x, point.z);
  const max = RULES.arenaRadius - radius;
  if (d > max) { point.x *= max / d; point.z *= max / d; }
  const min = RULES.crystalRadius + radius;
  if (d < min) {
    const k = d > 1e-6 ? min / d : 0;
    point.x = d > 1e-6 ? point.x * k : min; point.z = d > 1e-6 ? point.z * k : 0;
  }
}

/** Player movement; the client runs the same function to predict its own character. */
export function movePlayer(player: { x: number; z: number; angle: number }, input: Input, dt: number) {
  let mx = clamp(input.mx, -1, 1);
  let mz = clamp(input.mz, -1, 1);
  const length = Math.hypot(mx, mz);
  if (length > 1) { mx /= length; mz /= length; }
  player.x += mx * RULES.playerSpeed * dt;
  player.z += mz * RULES.playerSpeed * dt;
  clampToArena(player);
  const aim = Math.atan2(input.ax - player.x, input.az - player.z);
  if (Number.isFinite(aim) && Math.hypot(input.ax - player.x, input.az - player.z) > 0.2) player.angle = aim;
}
