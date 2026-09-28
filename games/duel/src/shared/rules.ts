import { seeded } from '@gaime/core';

export const RULES = {
  width: 80,
  step: 0.5,
  gravity: 25,
  moveSpeed: 4,
  aimSpeed: 70,
  countdownSeconds: 3,
  turnSeconds: 30,
  retreatSeconds: 3,
  maxWind: 8,
  hp: 100,
  playerRadius: 0.7,
  spawnX: 25,
  /** Seconds to charge a shot to full power (client). */
  chargeSeconds: 1.4,
  colors: ['#59e3ff', '#ff7a59'] as const,
};

export const TERRAIN_SAMPLES = Math.round(RULES.width / RULES.step) + 1;

/** Rolling hills with a flat-ish spot for each player; deterministic for a seed. */
export function generateTerrain(seed: number): number[] {
  const random = seeded(seed);
  const waves = Array.from({ length: 4 }, (_, i) => ({ amplitude: (random() * 2 + 1) / (i + 1), frequency: (i + 1) * (0.05 + random() * 0.05), phase: random() * Math.PI * 2 }));
  return Array.from({ length: TERRAIN_SAMPLES }, (_, i) => {
    const x = -RULES.width / 2 + i * RULES.step;
    const hills = waves.reduce((sum, w) => sum + w.amplitude * Math.sin(x * w.frequency + w.phase), 0);
    const plateau = Math.exp(-(((Math.abs(x) - RULES.spawnX) / 4) ** 2));
    return 4 + hills * (1 - plateau * 0.8);
  });
}

/** Ground height at x (linear interpolation, the edges extend flat). */
export function heightAt(terrain: readonly number[], x: number) {
  const f = (x + RULES.width / 2) / RULES.step;
  const i = Math.max(0, Math.min(terrain.length - 2, Math.floor(f)));
  const k = Math.max(0, Math.min(1, f - i));
  return terrain[i] + (terrain[i + 1] - terrain[i]) * k;
}

/** Carve a circular crater (mutates the array). */
export function carve(terrain: number[], at: { x: number; z: number }, radius: number) {
  for (let i = 0; i < terrain.length; i++) {
    const dx = -RULES.width / 2 + i * RULES.step - at.x;
    if (Math.abs(dx) >= radius) continue;
    const bottom = at.z - Math.sqrt(radius * radius - dx * dx);
    if (terrain[i] > bottom) terrain[i] = Math.max(-6, bottom);
  }
}

/** Muzzle position for a player aiming at `aim` degrees. */
export function muzzle(player: { x: number; z: number }, aim: number) {
  const radians = (aim * Math.PI) / 180;
  return { x: player.x + Math.cos(radians) * 1.2, z: player.z + 1 + Math.sin(radians) * 1.2 };
}
