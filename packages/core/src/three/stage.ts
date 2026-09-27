import * as THREE from 'three';

export interface StageOptions {
  container: HTMLElement;
  background?: THREE.ColorRepresentation;
  fov?: number;
  /** Cap for devicePixelRatio (performance on hi-dpi laptops). */
  maxPixelRatio?: number;
  shadows?: boolean;
}

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Register a per-frame callback (`dt` seconds, clamped to 0.1). Returns an unsubscribe. */
  onFrame(callback: (dt: number, now: number) => void): () => void;
  dispose(): void;
}

/** Renderer + scene + camera + resize + render loop, with complete teardown for HMR. */
export function createStage(options: StageOptions): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, options.maxPixelRatio ?? 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  if (options.shadows ?? true) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  options.container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? '#101418');
  const camera = new THREE.PerspectiveCamera(options.fov ?? 50, 1, 0.1, 500);

  const resize = () => {
    const { clientWidth: width, clientHeight: height } = options.container;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(options.container);
  resize();

  const callbacks = new Set<(dt: number, now: number) => void>();
  let last = performance.now();
  let frame = 0;
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    for (const callback of callbacks) callback(dt, now);
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(loop);

  return {
    renderer, scene, camera, canvas,
    onFrame(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      callbacks.clear();
      disposeObject(scene);
      renderer.dispose();
      canvas.remove();
    },
  };
}

/** Frees geometries, materials and textures of a subtree. */
export function disposeObject(root: THREE.Object3D) {
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}

const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

/** Point on the horizontal plane `y = height` under normalised screen coordinates. */
export function pickGround(camera: THREE.Camera, ndcX: number, ndcY: number, height = 0): { x: number; z: number } | undefined {
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  plane.constant = -height;
  return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : undefined;
}
