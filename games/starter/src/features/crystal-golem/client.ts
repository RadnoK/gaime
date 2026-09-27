import * as THREE from 'three';
import type { ClientFeature } from '../../client/features';

/** Custom model for `visual.shape: 'golem'`. Runs only in the browser. */
export default {
  models: {
    golem(visual) {
      const stone = new THREE.MeshStandardMaterial({ color: visual.color ?? '#8f7bff', roughness: 0.9, flatShading: true });
      const glow = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#c8b8ff', emissiveIntensity: 2 });
      const golem = new THREE.Group();
      const body = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55), stone);
      body.position.y = 0.75;
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28), stone);
      head.position.set(0, 1.35, 0.1);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07), glow);
      eye.position.set(0, 1.38, 0.34);
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.7, 0.28), stone);
        arm.position.set(side * 0.7, 0.7, 0.05);
        arm.rotation.z = side * 0.25;
        golem.add(arm);
      }
      golem.add(body, head, eye);
      golem.traverse(object => { object.castShadow = true; });
      return golem;
    },
  },
} satisfies ClientFeature;
