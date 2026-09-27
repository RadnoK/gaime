import * as THREE from 'three';
import { damp } from '../shared/math';

export interface CameraRigOptions {
  /** Camera position relative to the target. Default: angled top-down (0, 22, 16). */
  offset?: THREE.Vector3Like;
  /** Point looked at relative to the target (e.g. a little above the ground). */
  lookOffset?: THREE.Vector3Like;
  /** Follow stiffness (higher = snappier). Default 6. */
  damping?: number;
  /** World-space bounds the focus point is clamped to. */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Presets for the common game cameras (use as `offset`). */
export const CAMERA = {
  /** Angled top-down (arena, twin-stick, tower defense). */
  topDown: new THREE.Vector3(0, 22, 16),
  /** Steeper, almost vertical (RTS, board games). */
  overhead: new THREE.Vector3(0, 30, 6),
  /** Behind and above (third person following the aim direction is up to the game). */
  chase: new THREE.Vector3(0, 6, -10),
  /** Side view for games simulated on x (right) and z (up): camera on +Z screen axis. */
  side: new THREE.Vector3(0, 4, 38),
};

/**
 * A camera that follows a target smoothly, clamps to bounds and shakes on demand.
 *
 *   const rig = new CameraRig(stage.camera, { offset: CAMERA.topDown });
 *   stage.onFrame(dt => rig.update(me ?? { x: 0, z: 0 }, dt));
 *   net.on('event', name => { if (name === 'explosion') rig.shake(0.6); });
 */
export class CameraRig {
  readonly focus = new THREE.Vector3();
  private readonly offset: THREE.Vector3;
  private readonly lookOffset: THREE.Vector3;
  private trauma = 0;
  private started = false;

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly options: CameraRigOptions = {}) {
    this.offset = new THREE.Vector3().copy(options.offset ?? CAMERA.topDown);
    this.lookOffset = new THREE.Vector3().copy(options.lookOffset ?? { x: 0, y: 0, z: 0 });
  }

  setOffset(offset: THREE.Vector3Like) { this.offset.copy(offset); }

  /** Add screen shake (0..1, accumulates, decays over ~0.5 s). */
  shake(amount = 0.4) { this.trauma = Math.min(1, this.trauma + amount); }

  /** `target` in world coordinates: `{ x, z }` plus an optional `y`. */
  update(target: { x: number; y?: number; z: number }, dt: number) {
    const goal = new THREE.Vector3(target.x, target.y ?? 0, target.z);
    const bounds = this.options.bounds;
    if (bounds) { goal.x = Math.max(bounds.minX, Math.min(bounds.maxX, goal.x)); goal.z = Math.max(bounds.minZ, Math.min(bounds.maxZ, goal.z)); }
    if (!this.started) { this.focus.copy(goal); this.started = true; }
    else this.focus.lerp(goal, damp(this.options.damping ?? 6, dt));
    this.camera.position.copy(this.focus).add(this.offset);
    const look = this.focus.clone().add(this.lookOffset);
    if (this.trauma > 0) {
      const power = this.trauma * this.trauma;
      const jitter = () => (Math.random() * 2 - 1) * power;
      this.camera.position.x += jitter() * 0.6;
      this.camera.position.y += jitter() * 0.6;
      look.x += jitter() * 0.3;
      this.trauma = Math.max(0, this.trauma - dt * 2);
    }
    this.camera.lookAt(look);
  }
}
