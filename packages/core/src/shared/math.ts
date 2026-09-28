export type Vec2 = { x: number; z: number };

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist2 = (a: Vec2, b: Vec2) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
export const dist = (a: Vec2, b: Vec2) => Math.sqrt(dist2(a, b));
/** Angle around the Y axis, matching Three.js `rotation.y` for a model facing +Z. */
export const angleTo = (from: Vec2, to: Vec2) => Math.atan2(to.x - from.x, to.z - from.z);
export const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
/** Moves `value` towards `target` by at most `step`. */
export const approach = (value: number, target: number, step: number) =>
  value < target ? Math.min(target, value + step) : Math.max(target, value - step);
/** Frame-rate independent exponential smoothing factor. */
export const damp = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);

/** Nearest item within `range`, or undefined. */
export function nearest<T extends Vec2>(from: Vec2, items: Iterable<T>, range = Infinity, filter?: (item: T) => boolean): T | undefined {
  let best: T | undefined;
  let bestD = range * range;
  for (const item of items) {
    if (filter && !filter(item)) continue;
    const d = dist2(from, item);
    if (d <= bestD) { best = item; bestD = d; }
  }
  return best;
}

/** One mulberry32 step on a 32-bit state: returns the next state and a number in [0, 1). */
export function mulberry(state: number): [number, number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [next, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
}

/** Small deterministic PRNG (mulberry32) for reproducible tests. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
