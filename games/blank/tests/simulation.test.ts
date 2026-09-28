import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { replay, testGame } from '@gaime/core/server';
import { game } from '../src/server/game';
import { registry } from '../src/server/registry';
import { RULES } from '../src/shared/rules';

// testGame runs the same engine as the server (clock, timers, events, systems, modules) without a network.
const setup = () => testGame(game, { random: seeded(1) });

describe('blank', () => {
  test('pickups spawn up to the limit and give points when touched', () => {
    const t = setup();
    const ada = t.join('Ada');
    t.run(RULES.spawnEvery * (RULES.maxPickups + 3));
    expect(Object.keys(t.world.pickups).length).toBe(RULES.maxPickups);
    const pickup = Object.values(t.world.pickups)[0];
    Object.assign(t.player(ada), { x: pickup.x, z: pickup.z });
    t.tick();
    expect(t.world.pickups[pickup.id]).toBeUndefined();
    expect(t.player(ada).score).toBe(registry.kinds.pickups[pickup.kind].value);
    expect(t.events).toContainEqual({ name: 'pickup.collected', data: expect.objectContaining({ playerId: ada }) });
  });

  test('combo module: a second pickup within 2 s is worth double', () => {
    const t = setup();
    const ada = t.join('Ada');
    const place = () => t.act(sim => sim.spawnPickup('coin', t.player(ada)));
    place(); t.tick();
    expect(t.player(ada).score).toBe(1);
    place(); t.tick();
    expect(t.player(ada).score).toBe(3);
    t.run(2.5);
    place(); t.tick();
    expect(t.player(ada).score).toBe(4);
  });

  test('uncollected pickups expire (a timer saved in the world)', () => {
    const t = setup();
    t.join('Ada');
    t.run(RULES.spawnEvery + 0.1);
    const first = Object.keys(t.world.pickups)[0];
    expect(t.ctx.timeLeft(`pickup:${first}`)).toBeGreaterThan(RULES.pickupLife - 1);
    t.run(RULES.pickupLife);
    expect(t.world.pickups[first]).toBeUndefined();
    expect(t.triggeredOf('pickup.expired')).toContainEqual({ pickup: first });
  });

  test('players stay on the field; only the host resets scores', () => {
    const t = setup();
    const ada = t.join('Ada');
    const bob = t.join('Bob');
    t.input(ada, { mx: 1, mz: 1 });
    t.run(10);
    expect(t.player(ada).x).toBeLessThanOrEqual(RULES.size / 2);
    t.player(ada).score = 7;
    expect(t.command(bob, { type: 'reset-scores' })).toMatch(/host/);
    t.command(ada, { type: 'reset-scores' });
    expect(t.player(ada).score).toBe(0);
  });

  test('a bot collects pickups on its own', () => {
    const t = setup();
    t.join('Ada');
    const bot = t.addBot();
    t.run(20);
    expect(t.player(bot).score).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  test('a recorded session replays exactly', () => {
    const t = testGame(game, { seed: 5, record: true });
    const ada = t.join('Ada');
    t.addBot();
    for (let second = 0; second < 30; second++) { t.input(ada, { mx: Math.sin(second), mz: Math.cos(second) }); t.run(1); }
    const result = replay(game, JSON.parse(JSON.stringify(t.recording())));
    expect(result.diverged).toBeUndefined();
    expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
  });
});
