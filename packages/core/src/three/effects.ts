import * as THREE from 'three';
import type { Effect } from '../kit/effects';
import { createLabel } from './models';
import { disposeOwned } from './layer';

export interface EffectRenderer {
  /** Seconds the effect is visible. */
  life: number;
  create(effect: Effect): THREE.Object3D;
  /** `k` = age / life (0..1). */
  animate?(object: THREE.Object3D, effect: Effect, k: number): void;
}

export interface EffectsLayerOptions {
  /** Extra or replacement renderers by effect type. */
  renderers?: Record<string, EffectRenderer>;
  /** Maps simulation coordinates to the scene. Default: (x, y, z) → (x, y, z) — top-down on x/z. */
  project?(x: number, z: number, y: number): THREE.Vector3;
}

const fade = (object: THREE.Object3D, k: number) => {
  object.traverse(child => {
    const material = (child as THREE.Mesh).material as THREE.Material & { opacity?: number } | undefined;
    if (material && 'opacity' in material) { material.transparent = true; material.opacity = 1 - k; }
  });
};

/** Built-in effect types: tracer, pulse, hit, spawn, text, explosion. */
export function builtinEffects(project: (x: number, z: number, y: number) => THREE.Vector3): Record<string, EffectRenderer> {
  const color = (effect: Effect) => new THREE.Color(effect.color ?? '#ffffff');
  const basic = (effect: Effect) => new THREE.MeshBasicMaterial({ color: color(effect), transparent: true, side: THREE.DoubleSide, depthWrite: false });
  return {
    tracer: {
      life: 0.12,
      create: effect => new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([project(effect.x, effect.z, effect.y ?? 0.95), project(effect.x2 ?? effect.x, effect.z2 ?? effect.z, effect.y ?? 0.95)]),
        new THREE.LineBasicMaterial({ color: color(effect), transparent: true }),
      ),
      animate: (object, _effect, k) => fade(object, k),
    },
    pulse: {
      life: 0.45,
      create: effect => { const mesh = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), basic(effect)); mesh.position.copy(project(effect.x, effect.z, effect.y ?? 0.05)); return mesh; },
      animate: (object, effect, k) => { object.scale.setScalar(Math.max(0.01, (effect.radius ?? 1) * (0.2 + 0.8 * k))); fade(object, k); },
    },
    spawn: {
      life: 0.7,
      create: effect => { const mesh = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), basic(effect)); mesh.position.copy(project(effect.x, effect.z, effect.y ?? 0.05)); return mesh; },
      animate: (object, effect, k) => { object.scale.setScalar(Math.max(0.01, (effect.radius ?? 1) * 2 * (1 - k))); fade(object, k); },
    },
    hit: {
      life: 0.35,
      create: effect => { const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), basic(effect)); mesh.position.copy(project(effect.x, effect.z, effect.y ?? 0.8)); return mesh; },
      animate: (object, effect, k) => { object.scale.setScalar((effect.radius ?? 1) * (0.6 + k)); fade(object, k); },
    },
    explosion: {
      life: 0.6,
      create: effect => {
        const group = new THREE.Group();
        const core = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, depthWrite: false }));
        const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), basic({ ...effect, color: effect.color ?? '#ff8a3d' }));
        group.add(shell, core);
        group.position.copy(project(effect.x, effect.z, effect.y ?? 0.5));
        return group;
      },
      animate: (object, effect, k) => {
        const radius = effect.radius ?? 2;
        object.children[0].scale.setScalar(Math.max(0.01, radius * (0.4 + 0.8 * k)));
        object.children[1].scale.setScalar(Math.max(0.01, radius * 0.5 * (1 - k)));
        fade(object, k * k);
      },
    },
    text: {
      life: 1.1,
      create: effect => { const label = createLabel(effect.text ?? '', { color: effect.color ?? '#ffffff' }); label.position.copy(project(effect.x, effect.z, effect.y ?? 2)); return label; },
      animate: (object, effect, k) => { object.position.copy(project(effect.x, effect.z, (effect.y ?? 2) + k * 1.5)); fade(object, k); },
    },
  };
}

/**
 * Draws a world's effect stream. Effects start when the (interpolated) render time
 * reaches their timestamp and disappear after their renderer's `life`.
 *
 *   const effects = new EffectsLayer(stage.scene);
 *   net.on('world', world => effects.sync(world.effects));
 *   stage.onFrame(() => effects.update(clock.now()));
 */
export class EffectsLayer {
  readonly group = new THREE.Group();
  private readonly renderers: Record<string, EffectRenderer>;
  private readonly live = new Map<number, { object: THREE.Object3D; effect: Effect; renderer: EffectRenderer }>();
  /** Ids already played (or unknown types) that are still listed in the world. */
  private readonly done = new Set<number>();
  private readonly warned = new Set<string>();

  constructor(parent: THREE.Object3D, options: EffectsLayerOptions = {}) {
    const project = options.project ?? ((x, z, y) => new THREE.Vector3(x, y, z));
    this.renderers = { ...builtinEffects(project), ...options.renderers };
    parent.add(this.group);
  }

  /** Register effects from a received world (unknown ids are created, known ones ignored). */
  sync(effects: readonly Effect[]) {
    const listed = new Set(effects.map(effect => effect.id));
    for (const id of this.done) if (!listed.has(id)) this.done.delete(id);
    for (const effect of effects) {
      if (this.live.has(effect.id) || this.done.has(effect.id)) continue;
      const renderer = this.renderers[effect.type];
      if (!renderer) {
        if (!this.warned.has(effect.type)) { this.warned.add(effect.type); console.warn(`[gaime] no renderer for effect "${effect.type}" — pass one in EffectsLayer({ renderers })`); }
        this.done.add(effect.id);
        continue;
      }
      const object = renderer.create(effect);
      object.visible = false;
      this.group.add(object);
      this.live.set(effect.id, { object, effect, renderer });
    }
  }

  update(renderTime: number) {
    for (const [id, { object, effect, renderer }] of this.live) {
      const age = renderTime - effect.time;
      if (age > renderer.life || age < -2) {
        this.group.remove(object);
        disposeOwned(object);
        this.live.delete(id);
        this.done.add(id);
        continue;
      }
      object.visible = age >= 0;
      if (age >= 0) renderer.animate?.(object, effect, Math.min(1, age / Math.max(0.001, renderer.life)));
    }
  }

  dispose() {
    for (const { object } of this.live.values()) disposeOwned(object);
    this.live.clear();
    this.group.removeFromParent();
  }
}
