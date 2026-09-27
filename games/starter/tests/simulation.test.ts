import { describe, expect, test } from 'vitest';
import { baseWorld, seeded } from '@gaime/core';
import { testContext } from '@gaime/core/server';
import { registry } from '../src/server/registry';
import { command, createPlayer, createWorld, prepareWorld, step } from '../src/server/simulation';
import { RULES } from '../src/shared/rules';
import type { Input, World } from '../src/shared/types';

function setup() {
  const world = createWorld();
  const random = seeded(7);
  const { ctx } = testContext(world, { random });
  world.players.p = createPlayer(world, 'p', 'Ola', random);
  world.hostId = 'p';
  prepareWorld(world, registry);
  const run = (seconds: number, inputs: Record<string, Input> = {}) => {
    for (let t = 0; t < seconds; t += 1 / 30) { world.time += 1 / 30; step(world, registry, inputs, 1 / 30, ctx); }
  };
  return { world, ctx, run };
}

describe('starter', () => {
  test('every feature module loads and the catalog lists them', () => {
    expect(registry.lists.enemies.length).toBeGreaterThan(0);
    expect(registry.lists.waves.length).toBeGreaterThan(0);
    for (const id of RULES.defaultAbilities) expect(registry.kinds.abilities[id]).toBeDefined();
    expect(JSON.parse(JSON.stringify(createWorld()))).toEqual(createWorld());
    expect(baseWorld(1).schema).toBe(1);
  });

  test('players move but stay inside the arena and outside the crystal', () => {
    const { world, run } = setup();
    run(10, { p: { mx: 1, mz: 0, ax: 50, az: 0, fire: false } });
    expect(Math.hypot(world.players.p.x, world.players.p.z)).toBeLessThanOrEqual(RULES.arenaRadius);
    run(10, { p: { mx: -1, mz: 0, ax: 0, az: 0, fire: false } });
    expect(Math.hypot(world.players.p.x, world.players.p.z)).toBeGreaterThanOrEqual(RULES.crystalRadius);
  });

  test('only the host starts a round; waves spawn enemies that shooting kills', () => {
    const { world, ctx, run } = setup();
    world.players.q = createPlayer(world, 'q', 'Ala');
    expect(command(world, registry, 'q', { type: 'start' }, ctx)).toMatch(/host/);
    expect(command(world, registry, 'p', { type: 'start' }, ctx)).toBeUndefined();
    expect(world.phase).toBe('fight');
    run(4);
    const enemy = Object.values(world.enemies)[0];
    expect(enemy).toBeDefined();
    const before = enemy.hp;
    world.players.p.x = enemy.x - 3; world.players.p.z = enemy.z;
    run(0.2, { p: { mx: 0, mz: 0, ax: enemy.x, az: enemy.z, fire: true } });
    expect(world.enemies[enemy.id]?.hp ?? 0).toBeLessThan(before);
  });

  test('an undefended crystal falls and anyone can start a new round', () => {
    const { world, ctx, run } = setup();
    world.players.p.online = false;
    command(world, registry, 'p', { type: 'start' }, ctx);
    for (let i = 0; i < 200 && world.phase !== 'lost'; i++) run(5);
    expect(world.phase).toBe('lost');
    expect(command(world, registry, 'p', { type: 'restart' }, ctx)).toBeUndefined();
    expect(world.phase).toBe('lobby');
    expect(world.crystal.hp).toBe(RULES.crystalHp);
  });

  test('abilities respect cooldowns and equipping swaps slots', () => {
    const { world, ctx } = setup();
    command(world, registry, 'p', { type: 'cast', slot: 0, x: 5, z: 5 }, ctx);
    const readyAt = world.players.p.cooldowns[world.players.p.abilities[0]];
    expect(readyAt).toBeGreaterThan(world.time);
    command(world, registry, 'p', { type: 'equip', slot: 0, ability: world.players.p.abilities[1] }, ctx);
    expect(world.players.p.abilities[0]).not.toBe(world.players.p.abilities[1]);
  });

  test('state stays valid after a feature disappears (hot reload without it)', () => {
    const { world } = setup();
    world.enemies.ghost = { id: 'ghost', kind: 'removed-enemy', x: 0, z: 0, angle: 0, hp: 1, maxHp: 1, data: {} };
    world.players.p.abilities = ['removed-ability', 'pulse'];
    prepareWorld(world, registry);
    expect(world.enemies.ghost).toBeUndefined();
    expect(registry.kinds.abilities[world.players.p.abilities[0]]).toBeDefined();
  });
});
