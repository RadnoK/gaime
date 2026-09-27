import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testContext } from '@gaime/core/server';
import { registry } from '../src/server/registry';
import { command, createPlayer, createWorld, prepareWorld, step } from '../src/server/simulation';
import { RULES } from '../src/shared/rules';

function setup() {
  const world = createWorld();
  const random = seeded(1);
  const { ctx } = testContext(world, { random });
  world.players.a = createPlayer(world, 'a', 'Ada', random);
  world.hostId = 'a';
  prepareWorld(world, registry);
  const run = (seconds: number, input = { mx: 0, mz: 0 }) => {
    for (let t = 0; t < seconds; t += 1 / 30) { world.time += 1 / 30; step(world, registry, { a: input }, 1 / 30, ctx); }
  };
  return { world, ctx, run };
}

describe('blank', () => {
  test('pickups spawn up to the limit and give points when touched', () => {
    const { world, run } = setup();
    run(RULES.spawnEvery * (RULES.maxPickups + 3));
    expect(Object.keys(world.pickups).length).toBe(RULES.maxPickups);
    const pickup = Object.values(world.pickups)[0];
    Object.assign(world.players.a, { x: pickup.x, z: pickup.z });
    run(0.05);
    expect(world.pickups[pickup.id]).toBeUndefined();
    expect(world.players.a.score).toBe(registry.kinds.pickups[pickup.kind].value);
  });

  test('players stay on the field; only the host resets scores', () => {
    const { world, ctx, run } = setup();
    run(10, { mx: 1, mz: 1 });
    expect(world.players.a.x).toBeLessThanOrEqual(RULES.size / 2);
    world.players.a.score = 7;
    world.players.b = createPlayer(world, 'b', 'Bob');
    expect(command(world, 'b', { type: 'reset-scores' }, ctx)).toMatch(/host/);
    command(world, 'a', { type: 'reset-scores' }, ctx);
    expect(world.players.a.score).toBe(0);
  });
});
