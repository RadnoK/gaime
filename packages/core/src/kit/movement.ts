import { approach } from '../shared/math';

export interface MoveInput {
  /** Direction on each axis, -1..1 (keyboard, stick). Longer vectors are normalised. */
  mx: number;
  mz: number;
}

/**
 * Top-down movement on the x/z plane. Run the same function on the server (authority)
 * and on the client (prediction of your own character) so both agree.
 *
 * With `acceleration` the entity needs `vx`/`vz` fields and eases in and out;
 * without it movement is instant (arcade feel).
 */
export function moveTopDown(entity: { x: number; z: number; vx?: number; vz?: number }, input: MoveInput, speed: number, dt: number, acceleration?: number) {
  let mx = Number.isFinite(input.mx) ? Math.max(-1, Math.min(1, input.mx)) : 0;
  let mz = Number.isFinite(input.mz) ? Math.max(-1, Math.min(1, input.mz)) : 0;
  const length = Math.hypot(mx, mz);
  if (length > 1) { mx /= length; mz /= length; }
  if (acceleration === undefined) {
    entity.x += mx * speed * dt;
    entity.z += mz * speed * dt;
    return;
  }
  entity.vx = approach(entity.vx ?? 0, mx * speed, acceleration * dt);
  entity.vz = approach(entity.vz ?? 0, mz * speed, acceleration * dt);
  entity.x += entity.vx * dt;
  entity.z += entity.vz * dt;
}
