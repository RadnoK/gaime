import * as THREE from 'three';

export type Bar = THREE.Group & { userData: { fill: THREE.Mesh; width: number } };

const plane = new THREE.PlaneGeometry(1, 1);

/** Billboard health/progress bar. Call `setBar` with 0..1 and `faceCamera` every frame. */
export function createBar(width: number, color: THREE.ColorRepresentation, background: THREE.ColorRepresentation = '#000000'): Bar {
  const bar = new THREE.Group() as Bar;
  const back = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: background, transparent: true, opacity: 0.55, depthTest: false }));
  back.scale.set(width + 0.06, 0.16, 1);
  const fill = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color, depthTest: false }));
  fill.scale.set(width, 0.1, 1);
  fill.position.z = 0.001;
  back.renderOrder = 8; fill.renderOrder = 9;
  back.userData.sharedGeometry = true; fill.userData.sharedGeometry = true;
  bar.add(back, fill);
  bar.userData = { fill, width };
  return bar;
}

export function setBar(bar: Bar, value: number, color?: THREE.ColorRepresentation) {
  const { fill, width } = bar.userData;
  const k = Math.max(0.0001, Math.min(1, value));
  fill.scale.x = width * k;
  fill.position.x = -(width * (1 - k)) / 2;
  if (color !== undefined) (fill.material as THREE.MeshBasicMaterial).color.set(color);
}

/** Orient a billboard (bar, label group) towards the camera. */
export function faceCamera(object: THREE.Object3D, camera: THREE.Camera) {
  object.quaternion.copy(camera.quaternion);
  // Undo the parent's rotation so the billboard stays screen-aligned.
  if (object.parent) object.quaternion.premultiply(object.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
}
