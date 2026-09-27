import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testContext } from '@gaime/core/server';
import { registry } from '../src/server/registry';
import { botInput, command, createPlayer, createWorld, prepareWorld, step } from '../src/server/simulation';
import { carve, generateTerrain, heightAt, RULES } from '../src/shared/rules';
import type { Command, Input } from '../src/shared/types';

function setup() {
  const world = createWorld();
  let issue: (id: string, c: { type: string }) => string | void = () => {};
  const { ctx } = testContext(world, { random: seeded(11), command: (id, c) => issue(id, c) });
  issue = (id, c) => command(world, registry, id, c as Command, ctx);
  world.players.a = createPlayer(world, 'a', 'Ada');
  world.players.b = createPlayer(world, 'b', 'Bob');
  prepareWorld(world, registry);
  const run = (seconds: number, inputs: (() => Record<string, Input>) = () => ({})) => {
    for (let t = 0; t < seconds; t += 1 / 30) { world.time += 1 / 30; step(world, registry, inputs(), 1 / 30, ctx); }
  };
  return { world, ctx, run };
}

describe('duel', () => {
  test('terrain helpers: heights, craters', () => {
    const terrain = generateTerrain(3);
    const before = heightAt(terrain, 0);
    carve(terrain, { x: 0, z: before }, 3);
    expect(heightAt(terrain, 0)).toBeLessThan(before - 2);
    expect(heightAt(terrain, 10)).toBeCloseTo(heightAt(generateTerrain(3), 10));
  });

  test('seats, spectators, ready → countdown → playing', () => {
    const { world, run } = setup();
    expect([world.players.a.seat, world.players.b.seat]).toEqual([0, 1]);
    expect(createPlayer(world, 'c', 'Cy').seat).toBe(-1);
    command(world, registry, 'a', { type: 'ready' }, testContext(world).ctx);
    command(world, registry, 'b', { type: 'ready' }, testContext(world).ctx);
    run(0.1);
    expect(world.match.phase).toBe('countdown');
    run(3.1);
    expect(world.match.phase).toBe('playing');
    expect(world.turns?.order).toHaveLength(2);
  });

  test('only the active player fires, once per turn; the shot resolves and the turn passes', () => {
    const { world, ctx, run } = setup();
    for (const id of ['a', 'b']) command(world, registry, id, { type: 'ready' }, ctx);
    run(3.2);
    const active = world.turns!.order[world.turns!.index];
    const other = active === 'a' ? 'b' : 'a';
    expect(command(world, registry, other, { type: 'fire', power: 1 }, ctx)).toMatch(/Not your turn/);
    expect(command(world, registry, active, { type: 'fire', power: 0.6 }, ctx)).toBeUndefined();
    expect(command(world, registry, active, { type: 'fire', power: 0.6 }, ctx)).toMatch(/already/);
    expect(Object.keys(world.projectiles).length).toBe(1);
    run(8);
    expect(Object.keys(world.projectiles).length).toBe(0);
    expect(world.turns!.order[world.turns!.index]).toBe(other);
  });

  test('two bots play a whole round to a winner', () => {
    const { world, ctx, run } = setup();
    for (const id of ['a', 'b']) world.players[id].data['gaime-bot'] = true;
    const brains = () => Object.fromEntries(['a', 'b'].map(id => [id, botInput(world, id, ctx, registry)]).filter(([, input]) => input)) as Record<string, Input>;
    // Bots ready up again right after a round, so watch the win counters instead of the phase.
    for (let i = 0; i < 1500 && world.players.a.wins + world.players.b.wins === 0; i++) run(1, brains);
    expect(world.players.a.wins + world.players.b.wins).toBe(1);
    expect(world.match.round).toBeGreaterThanOrEqual(1);
    expect(Math.max(world.players.a.hp, world.players.b.hp)).toBeLessThanOrEqual(RULES.hp);
  }, 60000);
});
