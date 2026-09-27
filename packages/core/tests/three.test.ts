import { expect, test } from 'vitest';
import * as THREE from 'three';
import { ModelLibrary } from '../src/three/models';

// GLTFLoader reports progress with ProgressEvent, which Node does not have.
(globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class extends Event { constructor(type: string, init: object = {}) { super(type); Object.assign(this, init); } };

test('ModelLibrary.load centres and grounds a model after rotating it', async () => {
  // One triangle far from the origin: x 10..12, y 0..2, z 0..4.
  const positions = new Float32Array([10, 0, 0, 12, 0, 0, 10, 2, 4]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [10, 0, 0], max: [12, 2, 4] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}` }],
  };
  const models = new ModelLibrary();
  await models.load('triangle', `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString('base64')}`, { rotateY: Math.PI / 2, height: 2 });
  const object = models.build({ shape: 'triangle' });
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  expect((box.min.x + box.max.x) / 2).toBeCloseTo(0);
  expect((box.min.z + box.max.z) / 2).toBeCloseTo(0);
  expect(box.min.y).toBeCloseTo(0);
  expect(box.max.y).toBeCloseTo(2);
});
