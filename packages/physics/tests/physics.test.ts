import { describe, expect, test } from 'vitest';
import { baseWorld, type BasePlayer, type BaseWorld } from '@gaime/core';
import { defineGame, testGame } from '@gaime/core/server';
import { createPhysics, type Body, type PhysicsContact } from '@gaime/physics';

interface Ball extends Body { id: string; active?: boolean; heavy?: boolean }
interface World extends BaseWorld<BasePlayer> { balls: Record<string, Ball>; crates: Record<string, Ball>; wall: number | null }

const physics = createPhysics<World>({
  bodies: {
    balls: { shape: { circle: 0.5 }, restitution: 0.5, density: ball => (ball.heavy ? 10 : 1), include: ball => ball.active !== false },
    crates: { shape: { box: [1, 1] }, linearDamping: 2 },
  },
  statics: world => (world.wall === null ? [] : [{ key: 'wall', shape: { box: [1, 20] }, x: world.wall }]),
  contacts: true,
});

function game(gravity = false) {
  const p = gravity ? createPhysics<World>({ gravity: { x: 0, z: -10 }, bodies: { balls: { shape: { circle: 0.5 } } } }) : physics;
  return defineGame<World, unknown>({
    name: 'physics-test',
    createWorld: () => ({ ...baseWorld(1), balls: {}, crates: {}, wall: null }),
    createPlayer: (_world, id, name) => ({ id, name, online: true, data: {} }),
    parseInput: raw => raw,
    systems: [p.system()],
  });
}

const ball = (id: string, x: number, z: number, vx = 0, vz = 0) => ({ id, x, z, vx, vz, angle: 0, spin: 0 });
const run = (seconds: number, setup: (world: World) => void, gravity = false) => {
  const t = testGame(game(gravity));
  setup(t.world);
  t.run(seconds);
  return t;
};

describe('@gaime/physics', () => {
  test('bodies are created for new entities, removed with them, and missing fields get defaults', () => {
    const t = testGame(game());
    t.world.balls.a = { id: 'a', x: 1, z: 2 } as Ball;
    t.tick();
    expect(physics.count(t.ctx)).toBe(1);
    expect(t.world.balls.a).toMatchObject({ x: 1, z: 2, vx: 0, vz: 0, angle: 0, spin: 0 });
    t.world.crates.c = ball('c', 5, 5);
    t.world.balls.b = ball('b', -5, 0);
    t.tick();
    expect(physics.count(t.ctx)).toBe(3);
    delete t.world.balls.a;
    t.world.balls.b.active = false;
    t.tick();
    expect(physics.count(t.ctx)).toBe(1);
  });

  test('bodies move by their velocity and damping; gravity pulls along -z in side views', () => {
    const t = run(1, world => { world.balls.a = ball('a', 0, 0, 3, 0); world.crates.c = ball('c', 0, 10, 3, 0); });
    expect(t.world.balls.a.x).toBeCloseTo(3, 1);
    expect(t.world.crates.c.x).toBeLessThan(2);
    const fall = run(1, world => { world.balls.a = ball('a', 0, 10); }, true);
    expect(fall.world.balls.a.z).toBeLessThan(6);
    expect(fall.world.balls.a.vz).toBeCloseTo(-10, 0);
  });

  test('changes game code makes to x/z/vx/vz are respected (teleport, set velocity, impulse)', () => {
    const t = testGame(game());
    t.world.balls.a = ball('a', 0, 0, 2, 0);
    t.run(0.5);
    t.world.balls.a.x = 20;
    t.tick();
    expect(t.world.balls.a.x).toBeGreaterThan(20);
    physics.teleport(t.ctx, 'balls', 'a', { x: -5, z: -5 });
    t.tick();
    expect(t.world.balls.a).toMatchObject({ x: -5, z: -5, vx: 0, vz: 0 });
    physics.setVelocity(t.ctx, 'balls', 'a', { x: 0, z: 6 });
    t.run(1);
    expect(t.world.balls.a.z).toBeCloseTo(1, 1);
    // Impulse = mass × Δv: a disc of radius 0.5 and density 1 weighs π/4.
    expect(physics.mass(t.ctx, 'balls', 'a')).toBeCloseTo(Math.PI / 4, 4);
    physics.setVelocity(t.ctx, 'balls', 'a', { x: 0, z: 0 });
    physics.impulse(t.ctx, 'balls', 'a', { x: Math.PI / 4, z: 0 });
    expect(t.world.balls.a.vx).toBeCloseTo(1, 4);
    // A density derived from the entity changes the mass.
    t.world.balls.a.heavy = true;
    t.tick();
    expect(physics.mass(t.ctx, 'balls', 'a')).toBeCloseTo(10 * Math.PI / 4, 3);
  });

  test('invalid values written by game code are replaced by the physics state', () => {
    const t = testGame(game());
    t.world.balls.a = ball('a', 1, 1, 1, 0);
    t.tick();
    t.world.balls.a.x = NaN;
    t.world.balls.a.vz = Infinity;
    t.tick();
    expect(Number.isFinite(t.world.balls.a.x) && Number.isFinite(t.world.balls.a.vz)).toBe(true);
  });

  test('contacts trigger physics.contact with entity ids; statics block and are rebuilt when they change', () => {
    const t = testGame(game());
    t.world.balls.a = ball('a', -3, 0, 5, 0);
    t.world.balls.b = ball('b', 3, 0, -5, 0);
    t.run(1);
    const contacts = t.triggeredOf('physics.contact') as PhysicsContact[];
    expect(contacts[0]).toMatchObject({ started: true, sensor: false });
    expect([contacts[0].a.id, contacts[0].b.id].sort()).toEqual(['a', 'b']);
    expect(contacts[0].speed).toBeGreaterThan(0);
    // Restitution 0.5: they bounce apart.
    expect(t.world.balls.a.vx).toBeLessThan(0);

    t.clear();
    t.world.wall = 5;
    t.world.balls.c = ball('c', 0, 5, 8, 0);
    t.run(2);
    expect(t.world.balls.c.x).toBeLessThan(5);
    expect(t.triggeredOf('physics.contact')).toContainEqual(expect.objectContaining({ b: { collection: 'static', id: 'wall' } }));
    t.world.wall = null;
    physics.teleport(t.ctx, 'balls', 'c', { x: 0, z: 5 });
    physics.setVelocity(t.ctx, 'balls', 'c', { x: 8, z: 0 });
    t.run(2);
    expect(t.world.balls.c.x).toBeGreaterThan(10);
  });

  test('contacts are reported from every substep', () => {
    const fine = createPhysics<World>({ bodies: { balls: { shape: { circle: 0.5 } } }, contacts: true, substeps: 3 });
    const t = testGame({ ...game(), systems: [fine.system()] });
    t.world.balls.a = ball('a', -2, 0, 6, 0);
    t.world.balls.b = ball('b', 2, 0, -6, 0);
    t.run(1);
    expect(t.triggeredOf('physics.contact')).toContainEqual(expect.objectContaining({ started: true }));
  });

  test('raycast finds the first entity along a ray, skipping excluded ones', () => {
    const t = testGame(game());
    t.world.balls.a = ball('a', 0, 0);
    t.world.balls.b = ball('b', 5, 0);
    t.world.crates.c = ball('c', 10, 0);
    t.tick();
    expect(physics.raycast(t.ctx, { x: -10, z: 0 }, { x: 2, z: 0 }, 30)).toMatchObject({ collection: 'balls', id: 'a', point: { x: expect.closeTo(-0.5, 3), z: 0 }, normal: { x: -1, z: 0 } });
    expect(physics.raycast(t.ctx, { x: 0, z: 0 }, { x: 1, z: 0 }, 30, { exclude: { collection: 'balls', id: 'a' }, filter: hit => hit.collection === 'crates' })).toMatchObject({ id: 'c' });
    expect(physics.raycast(t.ctx, { x: 0, z: 0 }, { x: 0, z: 1 }, 30, { exclude: { collection: 'balls', id: 'a' } })).toBeUndefined();
  });

  const scene = (world: World) => {
    for (let i = 0; i < 40; i++) world.balls[`b${i}`] = ball(`b${i}`, (i % 8) * 1.3 - 5, Math.floor(i / 8) * 1.3 - 3, ((i * 7) % 5) - 2, ((i * 3) % 5) - 2);
    world.crates.c = ball('c', 0, 0, 1, 1);
    world.wall = 8;
  };

  test('deterministic: the same world and steps give the same result', () => {
    const a = run(5, scene);
    const b = run(5, scene);
    expect(JSON.stringify(a.world.balls)).toBe(JSON.stringify(b.world.balls));
    expect(JSON.stringify(a.world.crates)).toBe(JSON.stringify(b.world.crates));
  });

  test('after the Rapier world is dropped (hot reload) it is rebuilt from the JSON and continues', () => {
    const steady = run(3, scene);
    const reloaded = testGame(game());
    scene(reloaded.world);
    reloaded.run(1.5);
    reloaded.engine.dispose();
    expect(physics.count(reloaded.ctx)).toBe(0);
    reloaded.run(1.5);
    expect(physics.count(reloaded.ctx)).toBe(41);
    const drift = Object.values(steady.world.balls).map(b => Math.hypot(b.x - reloaded.world.balls[b.id].x, b.z - reloaded.world.balls[b.id].z));
    // Warm-starting data is lost, so contacts may resolve slightly differently — but only slightly.
    expect(drift.reduce((sum, d) => sum + d, 0) / drift.length).toBeLessThan(0.5);
    // Without contacts the continuation is exact.
    const free = (world: World) => { world.balls.a = ball('a', 0, 0, 1.5, -0.5); };
    const a = run(2, free);
    const b = testGame(game());
    free(b.world);
    b.run(1);
    physics.reset(b.ctx);
    b.run(1);
    expect(b.world.balls.a).toEqual(a.world.balls.a);
  });
});
