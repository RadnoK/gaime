import { describe, expect, test } from 'vitest';
import { createPhysics, type Body, type PhysicsContext } from '@gaime/physics';

// `npm run bench -w @gaime/physics`: ms per physics step (JSON sync + Rapier + write-back) at 30 Hz.
type World = { bodies: Record<string, Body & { id: string }> };

function setup(count: number, options: { contacts?: boolean; substeps?: number; packed?: boolean } = {}) {
  const size = options.packed ? 0.5 : 1;
  const physics = createPhysics<World>({
    bodies: { bodies: { shape: { circle: 0.5 }, restitution: 0.8, linearDamping: 0.2 } },
    // A closed arena, so the bodies keep colliding.
    statics: () => [
      { key: 'n', shape: { box: [60 * size, 1] }, z: -20 * size }, { key: 's', shape: { box: [60 * size, 1] }, z: 20 * size },
      { key: 'w', shape: { box: [1, 40 * size] }, x: -30 * size }, { key: 'e', shape: { box: [1, 40 * size] }, x: 30 * size },
    ],
    contacts: options.contacts,
    substeps: options.substeps,
  });
  const world: World = { bodies: {} };
  for (let i = 0; i < count; i++) {
    const id = `b${i}`;
    world.bodies[id] = { id, x: ((i % 28) * 2 - 27) * size, z: (Math.floor(i / 28) * 1.1 - 18) * size, vx: ((i * 7) % 11) - 5, vz: ((i * 5) % 9) - 4, angle: 0, spin: 0 };
  }
  const resources = new Map<string, unknown>();
  let contacts = 0;
  const ctx: PhysicsContext = {
    world,
    resource: <T>(key: string, create: () => T) => (resources.has(key) ? resources.get(key) : resources.set(key, create()).get(key)) as T,
    trigger: () => { contacts++; },
  };
  return { step: () => physics.step(ctx, 1 / 30), contacts: () => contacts };
}

describe.runIf(process.env.GAIME_BENCH)('physics step benchmark', () => {
  test('ms per step', () => {
    const rows: Record<string, { 'ms/step': number; 'contact events/step': number }> = {};
    for (const [label, count, options] of [
      ['100 bodies', 100, {}], ['300 bodies', 300, {}], ['300 bodies + contacts', 300, { contacts: true }],
      ['300 bodies, 2 substeps', 300, { substeps: 2 }],
      ['300 bodies packed (4× denser) + contacts', 300, { packed: true, contacts: true }], ['1000 bodies', 1000, {}],
    ] as const) {
      const bench = setup(count, options);
      for (let i = 0; i < 60; i++) bench.step();
      const before = bench.contacts();
      const steps = 300;
      const started = performance.now();
      for (let i = 0; i < steps; i++) bench.step();
      rows[label] = { 'ms/step': Math.round(((performance.now() - started) / steps) * 1000) / 1000, 'contact events/step': Math.round((bench.contacts() - before) / steps) };
    }
    console.table(rows);
    expect(rows['300 bodies']['ms/step']).toBeLessThan(33);
  });
});
