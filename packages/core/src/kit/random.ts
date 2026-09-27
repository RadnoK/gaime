/** Randomness helpers. Pass `ctx.random` (or `seeded(n)` in tests) to keep results reproducible. */
type Random = () => number;

export function range(random: Random, min: number, max: number) {
  return min + random() * (max - min);
}

export function int(random: Random, min: number, max: number) {
  return Math.floor(min + random() * (max - min + 1));
}

export function chance(random: Random, probability: number) {
  return random() < probability;
}

export function pick<T>(random: Random, items: readonly T[]): T | undefined {
  return items.length ? items[Math.floor(random() * items.length)] : undefined;
}

/** Weighted choice; items with weight ≤ 0 are never picked. */
export function weighted<T>(random: Random, items: readonly T[], weightOf: (item: T) => number): T | undefined {
  const total = items.reduce((sum, item) => sum + Math.max(0, weightOf(item)), 0);
  if (total <= 0) return undefined;
  let roll = random() * total;
  for (const item of items) {
    roll -= Math.max(0, weightOf(item));
    if (roll < 0) return item;
  }
  return items.at(-1);
}

/** New shuffled array (Fisher–Yates). */
export function shuffle<T>(random: Random, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Uniform point in a ring around a centre (spawn points). */
export function pointInRing(random: Random, center: { x: number; z: number }, inner: number, outer: number) {
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(range(random, inner * inner, outer * outer));
  return { x: center.x + Math.sin(angle) * radius, z: center.z + Math.cos(angle) * radius };
}

/** Point on a circle (arena edge spawns). */
export function pointOnCircle(random: Random, center: { x: number; z: number }, radius: number) {
  const angle = random() * Math.PI * 2;
  return { x: center.x + Math.sin(angle) * radius, z: center.z + Math.cos(angle) * radius };
}
