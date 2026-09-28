import { describe, expect, test } from 'vitest';
import { createRegistry, seeded } from '@gaime/core';
import { replay, testGame } from '@gaime/core/server';
import { game } from '../src/server/game';
import { physics } from '../src/server/physics';
import { RULES } from '../src/shared/rules';
import type { Feature, Kinds } from '../src/shared/types';

// testGame runs the same engine as the server (clock, timers, events, systems, modules, physics) without a network.
const setup = (options: Parameters<typeof testGame>[1] = {}) => testGame(game, { random: seeded(1), ...options });

/** Two players, both ready, countdown over: the round is on. */
function round(t = setup()) {
  const ada = t.join('Ada');
  const bob = t.join('Bob');
  t.command(ada, { type: 'ready' });
  t.command(bob, { type: 'ready' });
  t.run(RULES.countdownSeconds + 0.2);
  expect(t.world.match.phase).toBe('playing');
  return { t, ada, bob };
}

describe('bumper', () => {
  test('a disc pushed over the edge is out, credited to the pusher; the last one standing wins and scores', () => {
    const { t, ada, bob } = round();
    Object.assign(t.player(bob), { x: RULES.arena - 1.2, z: 0, vx: 0, vz: 0 });
    Object.assign(t.player(ada), { x: RULES.arena - 4, z: 0, vx: 20, vz: 0 });
    t.run(2, () => t.world.match.phase === 'ended');
    expect(t.triggeredOf('player.knocked')).toEqual([{ player: bob, by: ada }]);
    expect(t.player(bob).alive).toBe(false);
    expect(t.world.match).toMatchObject({ phase: 'ended', winner: ada });
    expect(t.triggeredOf('round.won')).toEqual([{ round: 1, player: ada }]);
    expect(t.player(ada).wins).toBe(1);
    expect(t.events).toContainEqual({ name: 'player.bumped', data: expect.objectContaining({ a: expect.any(String) }) });
    // Between rounds everyone is back on the arena.
    t.run(RULES.respawnSeconds + 0.1);
    expect(t.player(bob).alive).toBe(true);
    // Ready again → a new round with everyone back on the arena.
    t.command(ada, { type: 'ready' });
    t.command(bob, { type: 'ready' });
    t.run(RULES.countdownSeconds + 0.2);
    expect(t.world.match).toMatchObject({ phase: 'playing', round: 2 });
    expect(t.player(bob).alive).toBe(true);
  });

  test('steering and dashing move the disc; a dash has a cooldown', () => {
    const { t, ada } = round();
    t.input(ada, { mx: 1, mz: 0 });
    t.run(0.5);
    expect(t.player(ada).vx).toBeGreaterThan(3);
    t.input(ada, undefined);
    t.command(ada, { type: 'dash', x: 0, z: 1 });
    t.command(ada, { type: 'dash', x: 0, z: 1 });
    expect(t.triggeredOf('dash.used')).toEqual([{ player: ada, power: RULES.dash }]);
    t.tick();
    expect(t.player(ada).vz).toBeGreaterThan(RULES.dash * 0.9);
    // Without a direction the dash follows the current velocity.
    Object.assign(t.player(ada), { x: 0, z: 0, vx: 4, vz: 0 });
    t.run(RULES.dashCooldown + 0.1);
    t.command(ada, { type: 'dash' });
    expect(t.triggeredOf('dash.used')).toHaveLength(2);
    t.tick();
    expect(t.player(ada).vx).toBeGreaterThan(RULES.dash * 0.9);
  });

  test('outside rounds, a disc that falls off comes back', () => {
    const t = setup();
    const ada = t.join('Ada');
    t.player(ada).x = RULES.arena + 2;
    t.tick();
    expect(t.player(ada).alive).toBe(false);
    t.run(RULES.respawnSeconds + 0.1);
    expect(t.player(ada).alive).toBe(true);
    expect(Math.hypot(t.player(ada).x, t.player(ada).z)).toBeLessThan(RULES.arena);
  });

  test('powerups: the anvil triples the mass, turbo strengthens the dash, a knockout gives a streak', () => {
    const { t, ada, bob } = round();
    t.act(sim => sim.spawnPickup('anvil', t.player(ada)));
    t.tick(2);
    expect(t.triggeredOf('pickup.collected')).toEqual([expect.objectContaining({ player: ada, kind: 'anvil' })]);
    expect(t.player(ada).mass).toBe(3);
    expect(physics.mass(t.ctx, 'players', ada)).toBeCloseTo(3 * Math.PI * RULES.radius ** 2, 3);
    t.run(7);
    expect(t.player(ada).mass).toBe(1);

    t.act(sim => sim.spawnPickup('turbo', t.player(bob)));
    t.tick();
    t.command(bob, { type: 'dash', x: 1, z: 0 });
    expect(t.triggeredOf('dash.used').at(-1)).toEqual({ player: bob, power: RULES.dash * 1.6 });

    // Behaviour-only module: pushing someone off gives the pusher a speed burst.
    t.act(sim => sim.knockOut(bob, ada));
    expect(t.player(ada).data['streak:until']).toBeGreaterThan(t.world.time);
  });

  test('bots play a whole round on their own', () => {
    const t = setup();
    const bots = [t.addBot(), t.addBot(), t.addBot()];
    const ticks = t.run(RULES.roundSeconds + 10, () => t.world.match.phase === 'ended');
    expect(t.world.match.phase).toBe('ended');
    expect(t.triggeredOf('player.knocked').length).toBeGreaterThanOrEqual(t.world.match.winner ? 2 : 1);
    if (t.world.match.winner) expect(bots).toContain(t.world.match.winner);
    // Most rounds end by knockouts well before the time limit.
    expect(ticks / 30).toBeLessThan(RULES.roundSeconds);
  });

  test('the same inputs give the same round (deterministic physics)', () => {
    const play = () => {
      const t = setup();
      t.addBot(); t.addBot();
      t.run(40);
      return JSON.stringify(Object.values(t.world.players).map(p => [p.x, p.z, p.vx, p.vz, p.alive, p.wins]));
    };
    expect(play()).toBe(play());
  });

  test('a hot reload (the physics world dropped) keeps the round going from the saved JSON', () => {
    const { t, ada, bob } = round();
    t.input(ada, { mx: 1, mz: 0 });
    t.run(0.5);
    const before = { ...t.player(ada) };
    t.engine.dispose();
    t.tick();
    expect(physics.count(t.ctx)).toBe(2);
    expect(t.player(ada).x).toBeGreaterThan(before.x);
    expect(t.player(bob).alive).toBe(true);
  });

  test('a failing module is switched off; the game keeps running', () => {
    const modules = {
      ...import.meta.glob<{ default: Feature }>('../src/features/*/server.ts', { eager: true }),
      '../src/features/broken/server.ts': { default: { modify: { 'push.mass': () => { throw new Error('boom'); } } } satisfies Feature },
    };
    const features = createRegistry<Kinds>(modules, { kinds: ['powerups'] });
    const { t, ada } = round(testGame({ ...game, features }, { random: seeded(1), strict: false }));
    t.input(ada, { mx: 1, mz: 0 });
    t.run(1);
    expect(t.disabled).toHaveProperty('broken');
    expect(t.world.pause).toBeNull();
    expect(t.feed().some(line => line.includes('broken'))).toBe(true);
    expect(t.player(ada).mass).toBe(1);
    expect(t.player(ada).vx).toBeGreaterThan(3);
  });
});

describe('determinism', () => {
  test('a recording that starts mid-game replays exactly (Rapier state is saved with each segment)', () => {
    // Short segments: the oldest ones are dropped, so the replay starts from a mid-round snapshot.
    const short = { ...game, record: { minutes: 0.05 } };
    const t = testGame(short, { seed: 9, record: true });
    const ada = t.join('Ada');
    t.addBot(); t.addBot(); t.addBot();
    t.command(ada, { type: 'ready' });
    for (let second = 0; second < 60; second++) { t.input(ada, { mx: Math.sin(second), mz: Math.cos(second) }); t.run(1); }
    const recording = JSON.parse(JSON.stringify(t.recording()));
    expect(recording.segments[0].startTick).toBeGreaterThan(0);
    expect(Object.keys(recording.segments[0].state.resources ?? {})).toContain('gaime-physics');
    const result = replay(short, recording);
    expect(result.diverged).toBeUndefined();
    expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
  });
});
