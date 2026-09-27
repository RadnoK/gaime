import type { Vec2 } from '../shared/math';

/** Everything here works on the x/z plane. For side-view games use z as "up". */

export function circlesOverlap(a: Vec2, ra: number, b: Vec2, rb: number) {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2 <= (ra + rb) ** 2;
}

export interface Rect { x: number; z: number; width: number; depth: number }

export function pointInRect(point: Vec2, rect: Rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.z >= rect.z && point.z <= rect.z + rect.depth;
}

export function circleRect(center: Vec2, radius: number, rect: Rect) {
  const x = Math.max(rect.x, Math.min(center.x, rect.x + rect.width));
  const z = Math.max(rect.z, Math.min(center.z, rect.z + rect.depth));
  return (center.x - x) ** 2 + (center.z - z) ** 2 <= radius * radius;
}

/**
 * Distance along a ray (origin + t·direction, |direction| = 1) to the first contact
 * with a circle, or null. Starting inside the circle returns 0.
 */
export function rayCircle(origin: Vec2, direction: Vec2, maxDistance: number, center: Vec2, radius: number): number | null {
  const ox = origin.x - center.x;
  const oz = origin.z - center.z;
  const c = ox * ox + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const b = ox * direction.x + oz * direction.z;
  if (b > 0) return null;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const t = -b - Math.sqrt(discriminant);
  return t <= maxDistance ? t : null;
}

export interface RayHit<T> { item: T; distance: number; point: Vec2 }

/**
 * Hitscan: the closest item hit by a ray from `origin` in `angle` (radians, 0 = +Z,
 * matching `angleTo` and Three.js rotation.y) within `range`.
 */
export function raycast<T extends Vec2>(origin: Vec2, angle: number, range: number, items: Iterable<T>, radiusOf: (item: T) => number, filter?: (item: T) => boolean): RayHit<T> | undefined {
  const direction = { x: Math.sin(angle), z: Math.cos(angle) };
  let best: RayHit<T> | undefined;
  for (const item of items) {
    if (filter && !filter(item)) continue;
    const t = rayCircle(origin, direction, best?.distance ?? range, item, radiusOf(item));
    if (t === null) continue;
    best = { item, distance: t, point: { x: origin.x + direction.x * t, z: origin.z + direction.z * t } };
  }
  return best;
}

/** End point of a ray that hit nothing (for tracers). */
export function rayEnd(origin: Vec2, angle: number, distance: number): Vec2 {
  return { x: origin.x + Math.sin(angle) * distance, z: origin.z + Math.cos(angle) * distance };
}

/**
 * Push overlapping circles apart (soft crowd separation). Mutates positions.
 * O(n²): fine for a few hundred items; use SpatialHash queries beyond that.
 */
export function separate<T extends Vec2>(items: T[], radiusOf: (item: T) => number, strength = 0.5) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]; const b = items[j];
      const min = radiusOf(a) + radiusOf(b);
      const dx = b.x - a.x; const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d >= min) continue;
      // Exactly on top of each other: a deterministic direction per pair (golden angle).
      const nx = d < 1e-6 ? Math.cos(j * 2.399963) : dx / d;
      const nz = d < 1e-6 ? Math.sin(j * 2.399963) : dz / d;
      const push = (min - d) * strength;
      a.x -= nx * push; a.z -= nz * push;
      b.x += nx * push; b.z += nz * push;
    }
  }
}

/** Keep a point inside a circle of `radius` around the origin (minus the entity's own radius). */
export function clampToCircle(point: Vec2, radius: number, margin = 0) {
  const d = Math.hypot(point.x, point.z);
  const max = radius - margin;
  if (d > max && d > 0) { point.x *= max / d; point.z *= max / d; }
}

/** Keep a point outside a circle (e.g. a central building). */
export function keepOutOfCircle(point: Vec2, center: Vec2, radius: number) {
  const dx = point.x - center.x; const dz = point.z - center.z;
  const d = Math.hypot(dx, dz);
  if (d >= radius) return;
  if (d < 1e-6) { point.x = center.x + radius; return; }
  point.x = center.x + (dx / d) * radius; point.z = center.z + (dz / d) * radius;
}

export function clampToRect(point: Vec2, rect: Rect, margin = 0) {
  point.x = Math.max(rect.x + margin, Math.min(rect.x + rect.width - margin, point.x));
  point.z = Math.max(rect.z + margin, Math.min(rect.z + rect.depth - margin, point.z));
}
