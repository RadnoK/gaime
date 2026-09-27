import type { Vec2 } from '../shared/math';

/**
 * Uniform grid for proximity queries on the x/z plane. Rebuild it once per tick from
 * the current entities, then ask "who is near this point" in ~O(1) instead of O(n).
 * Worth it from roughly a hundred entities up; below that a plain loop is fine.
 *
 *   const grid = new SpatialHash<Enemy>(4);
 *   grid.rebuild(Object.values(world.enemies));
 *   for (const enemy of grid.query(player, 6)) …
 *
 * Not serialisable — create it inside `step` (or keep it in a module variable and
 * rebuild it every tick; it never holds state that must survive a reload).
 */
export class SpatialHash<T extends Vec2> {
  private readonly cells = new Map<number, T[]>();

  constructor(readonly cellSize = 4) {
    if (!(cellSize > 0)) throw new Error('SpatialHash: cellSize must be positive.');
  }

  private key(cx: number, cz: number) {
    // Cantor-free packing: fine for |coordinates| < ~1e6 cells.
    return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
  }

  clear() { this.cells.clear(); }

  insert(item: T) {
    const key = this.key(Math.floor(item.x / this.cellSize), Math.floor(item.z / this.cellSize));
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, cell = []);
    cell.push(item);
  }

  rebuild(items: Iterable<T>) {
    this.clear();
    for (const item of items) this.insert(item);
    return this;
  }

  /** Items whose position is within `radius` of `from`, optionally filtered. */
  query(from: Vec2, radius: number, filter?: (item: T) => boolean): T[] {
    const out: T[] = [];
    const r2 = radius * radius;
    const minX = Math.floor((from.x - radius) / this.cellSize);
    const maxX = Math.floor((from.x + radius) / this.cellSize);
    const minZ = Math.floor((from.z - radius) / this.cellSize);
    const maxZ = Math.floor((from.z + radius) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const cell = this.cells.get(this.key(cx, cz));
        if (!cell) continue;
        for (const item of cell) {
          if ((item.x - from.x) ** 2 + (item.z - from.z) ** 2 > r2) continue;
          if (filter && !filter(item)) continue;
          out.push(item);
        }
      }
    }
    return out;
  }

  /** Nearest item within `radius`, or undefined. */
  nearest(from: Vec2, radius: number, filter?: (item: T) => boolean): T | undefined {
    let best: T | undefined;
    let bestD = Infinity;
    for (const item of this.query(from, radius, filter)) {
      const d = (item.x - from.x) ** 2 + (item.z - from.z) ** 2;
      if (d < bestD) { best = item; bestD = d; }
    }
    return best;
  }
}
