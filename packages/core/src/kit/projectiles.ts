import type { Vec2 } from '../shared/math';

/**
 * Simulated projectiles (bullets, grenades, artillery shells) as plain world data.
 * Keep them in a `Record<string, Projectile>` in your World and list that key in
 * `network.entities`. Motion is on the x/z plane; for a side view treat z as "up"
 * and pass `gravity: { x: 0, z: -20 }`.
 */
export interface Projectile {
  id: string;
  /** Definition id (weapon, spell…) — look up damage/radius in your registry. */
  kind: string;
  owner: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Collision radius. */
  radius: number;
  /** World time when it expires. */
  expiresAt: number;
  /** Free-form state; prefix keys with your module id. */
  data: Record<string, number | string | boolean>;
}

export interface LaunchOptions {
  id: string;
  kind: string;
  owner: string;
  from: Vec2;
  /** Radians, 0 = +Z (as `angleTo`). */
  angle: number;
  speed: number;
  radius?: number;
  /** Seconds of flight before it expires. Default 3. */
  life?: number;
  time: number;
  data?: Projectile['data'];
}

export function launch(options: LaunchOptions): Projectile {
  return {
    id: options.id, kind: options.kind, owner: options.owner,
    x: options.from.x, z: options.from.z,
    vx: Math.sin(options.angle) * options.speed, vz: Math.cos(options.angle) * options.speed,
    radius: options.radius ?? 0.2,
    expiresAt: options.time + (options.life ?? 3),
    data: { ...options.data },
  };
}

export interface StepProjectilesOptions<T> {
  dt: number;
  time: number;
  /** Constant acceleration (gravity, wind), units/s². */
  gravity?: Vec2;
  /** Extra per-projectile acceleration (e.g. wind susceptibility). */
  accelerate?(projectile: Projectile): Vec2 | undefined;
  /**
   * What a projectile can hit this step (return undefined for nothing). A target with an `id`
   * is hit at most once per projectile: piercing shots skip it afterwards (see `wasHit`).
   */
  hit?(projectile: Projectile): T | undefined;
  /** Solid geometry: return true when the point is inside the ground/wall. */
  solid?(point: Vec2): boolean;
  /** Called on impact; return true to keep the projectile alive (piercing, bouncing). */
  onImpact?(projectile: Projectile, target: T | undefined, point: Vec2): boolean | void;
  /** Called when a projectile expires without hitting anything. */
  onExpire?(projectile: Projectile): void;
  /** Sub-steps per tick so fast projectiles cannot tunnel through thin things. Default: automatic. */
  substeps?: number;
}

const HIT = 'gaime-hit:';
const targetId = (target: unknown) => {
  const id = (target as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
};

/** True when a kept-alive (piercing) projectile already hit the target with this id. */
export function wasHit(projectile: Projectile, id: string | number) {
  return projectile.data[HIT + id] === true;
}

/** Moves every projectile in `projectiles`, resolves hits, removes finished ones. */
export function stepProjectiles<T>(projectiles: Record<string, Projectile>, options: StepProjectilesOptions<T>) {
  for (const projectile of Object.values(projectiles)) {
    if (!projectiles[projectile.id]) continue;
    if (options.time >= projectile.expiresAt) {
      delete projectiles[projectile.id];
      options.onExpire?.(projectile);
      continue;
    }
    const speed = Math.hypot(projectile.vx, projectile.vz);
    const steps = options.substeps ?? Math.max(1, Math.min(16, Math.ceil((speed * options.dt) / Math.max(0.05, projectile.radius))));
    const dt = options.dt / steps;
    for (let i = 0; i < steps; i++) {
      const extra = options.accelerate?.(projectile);
      projectile.vx += ((options.gravity?.x ?? 0) + (extra?.x ?? 0)) * dt;
      projectile.vz += ((options.gravity?.z ?? 0) + (extra?.z ?? 0)) * dt;
      projectile.x += projectile.vx * dt;
      projectile.z += projectile.vz * dt;
      const point = { x: projectile.x, z: projectile.z };
      let target = options.hit?.(projectile);
      const id = targetId(target);
      if (id !== undefined && wasHit(projectile, id)) target = undefined;
      const ground = !target && options.solid?.(point);
      if (!target && !ground) continue;
      const keep = options.onImpact?.(projectile, target, point) === true;
      if (!keep) { delete projectiles[projectile.id]; break; }
      if (target && id !== undefined) projectile.data[HIT + id] = true;
    }
  }
}

/**
 * Launch angle (radians from +X towards +Z) that makes a ballistic shot with `speed`
 * land on `target`, under gravity `g` pointing to -Z. Returns the low arc, or null
 * when the target is out of range. Handy for bots and aim assist in side-view games.
 */
export function ballisticAngle(from: Vec2, target: Vec2, speed: number, g: number): number | null {
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const v2 = speed * speed;
  const root = v2 * v2 - g * (g * dx * dx + 2 * dz * v2);
  if (root < 0) return null;
  const angle = Math.atan2(v2 - Math.sqrt(root), g * Math.abs(dx));
  return dx >= 0 ? angle : Math.PI - angle;
}
