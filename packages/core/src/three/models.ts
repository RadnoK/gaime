import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Visual } from '../shared/types';

export type ModelFactory = (visual: Visual) => THREE.Object3D;

const geometries = new Map<string, THREE.BufferGeometry>();
const geometry = (key: string, make: () => THREE.BufferGeometry) => {
  let value = geometries.get(key);
  if (!value) geometries.set(key, value = make());
  return value;
};

/** Built-in shapes, all roughly 1 unit tall and standing on y = 0. */
const PRIMITIVES: Record<string, () => THREE.BufferGeometry> = {
  box: () => geometry('box', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
  sphere: () => geometry('sphere', () => new THREE.SphereGeometry(0.5, 24, 16).translate(0, 0.5, 0)),
  capsule: () => geometry('capsule', () => new THREE.CapsuleGeometry(0.35, 0.6, 6, 16).translate(0, 0.65, 0)),
  cone: () => geometry('cone', () => new THREE.ConeGeometry(0.5, 1, 20).translate(0, 0.5, 0)),
  cylinder: () => geometry('cylinder', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 20).translate(0, 0.5, 0)),
  torus: () => geometry('torus', () => new THREE.TorusGeometry(0.4, 0.14, 12, 32).rotateX(Math.PI / 2).translate(0, 0.2, 0)),
  octahedron: () => geometry('octahedron', () => new THREE.OctahedronGeometry(0.5).translate(0, 0.5, 0)),
  ring: () => geometry('ring', () => new THREE.RingGeometry(0.4, 0.5, 32).rotateX(-Math.PI / 2).translate(0, 0.02, 0)),
};

/**
 * Turns server-chosen `Visual` descriptors into meshes. Features register extra
 * shapes from their `client.ts`; unknown shapes fall back to a box so nothing breaks.
 */
export class ModelLibrary {
  private readonly custom = new Map<string, ModelFactory>();

  register(shape: string, factory: ModelFactory) { this.custom.set(shape, factory); }

  /**
   * Register a glTF/GLB file (from `public/`, e.g. '/models/tree.glb') as a shape.
   * Await it before the first render; the model is normalised to stand on y = 0,
   * facing +Z, `height` units tall (default 1) — then `visual.scale` applies as usual.
   */
  async load(shape: string, url: string, options: { height?: number; rotateY?: number; tint?: boolean } = {}) {
    const source = await loadGltf(url);
    const template = source.clone(true);
    // Rotate first, then centre the rotated bounds (rotating after centring moves the model off-centre).
    template.rotation.y = options.rotateY ?? 0;
    template.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(template);
    const size = box.getSize(new THREE.Vector3());
    const scale = (options.height ?? 1) / (size.y || 1);
    const wrapper = new THREE.Group();
    template.position.x -= (box.min.x + box.max.x) / 2;
    template.position.y -= box.min.y;
    template.position.z -= (box.min.z + box.max.z) / 2;
    wrapper.add(template);
    wrapper.scale.setScalar(scale);
    this.register(shape, visual => {
      const model = cloneSkinned(wrapper);
      model.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        // Materials are shared with the cache; tinting needs a private copy.
        if (options.tint && visual.color) {
          mesh.material = (mesh.material as THREE.MeshStandardMaterial).clone();
          (mesh.material as THREE.MeshStandardMaterial).color.set(visual.color);
        } else mesh.userData.sharedMaterial = true;
        mesh.userData.sharedGeometry = true;
      });
      return model;
    });
  }
  has(shape: string) { return this.custom.has(shape) || shape in PRIMITIVES; }

  build(visual: Visual): THREE.Object3D {
    const root = new THREE.Group();
    let body: THREE.Object3D;
    const factory = this.custom.get(visual.shape);
    if (factory) {
      try { body = factory(visual); }
      catch (error) { console.error(`[gaime] model "${visual.shape}"`, error); body = this.primitive({ ...visual, shape: 'box' }); }
    } else {
      if (!(visual.shape in PRIMITIVES)) console.warn(`[gaime] unknown shape "${visual.shape}" — drawing a box`);
      body = this.primitive(visual);
    }
    const scale = visual.scale ?? 1;
    if (Array.isArray(scale)) body.scale.set(scale[0], scale[1], scale[2]); else body.scale.setScalar(scale);
    body.position.y += visual.lift ?? 0;
    body.name = 'body';
    root.add(body);
    return root;
  }

  private primitive(visual: Visual) {
    const make = PRIMITIVES[visual.shape] ?? PRIMITIVES.box;
    const material = new THREE.MeshStandardMaterial({
      color: visual.color ?? '#cccccc',
      emissive: visual.emissive ?? '#000000',
      emissiveIntensity: visual.emissive ? 0.8 : 0,
      roughness: 0.55,
      metalness: 0.1,
      side: visual.shape === 'ring' ? THREE.DoubleSide : THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(make(), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Shared geometry: never dispose it with the entity.
    mesh.userData.sharedGeometry = true;
    return mesh;
  }
}

/** Camera-facing text label (names, damage numbers). Update with `setLabel`. */
export function createLabel(text: string, options: { color?: string; size?: number; background?: string } = {}) {
  const canvas = document.createElement('canvas');
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
  sprite.renderOrder = 10;
  sprite.userData.label = { canvas, options, text: '' };
  setLabel(sprite, text);
  return sprite;
}

export function setLabel(sprite: THREE.Sprite, text: string) {
  const state = sprite.userData.label as { canvas: HTMLCanvasElement; options: { color?: string; size?: number; background?: string }; text: string };
  if (state.text === text) return;
  state.text = text;
  const { canvas, options } = state;
  const px = 48;
  const context = canvas.getContext('2d')!;
  context.font = `600 ${px}px system-ui, sans-serif`;
  const width = Math.ceil(context.measureText(text).width) + 24;
  canvas.width = width; canvas.height = px + 20;
  context.font = `600 ${px}px system-ui, sans-serif`;
  if (options.background) { context.fillStyle = options.background; context.beginPath(); context.roundRect(0, 0, width, canvas.height, 14); context.fill(); }
  context.fillStyle = options.color ?? '#ffffff';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(text, width / 2, canvas.height / 2 + 2);
  const texture = (sprite.material as THREE.SpriteMaterial).map!;
  texture.needsUpdate = true;
  const size = options.size ?? 0.45;
  sprite.scale.set((size * width) / canvas.height, size, 1);
}

const gltfCache = new Map<string, Promise<THREE.Object3D>>();
const gltfLoader = new GLTFLoader();

/** Loads a glTF/GLB once per URL; clone the result before adding it to a scene. */
export function loadGltf(url: string): Promise<THREE.Object3D> {
  let pending = gltfCache.get(url);
  if (!pending) {
    pending = gltfLoader.loadAsync(url).then(gltf => gltf.scene);
    gltfCache.set(url, pending);
  }
  return pending;
}
