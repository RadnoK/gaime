import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { currentTurn } from '@gaime/core/kit';
import { replay, testGame, type TestGameOptions } from '@gaime/core/server';
import { game } from '../src/server/game';
import { registry } from '../src/server/registry';
import { carve, generateTerrain, heightAt, RULES } from '../src/shared/rules';
import type { World } from '../src/shared/types';

// testGame runs the same engine as the server (clock, timers, events, systems, modules) without a network.
const setup = (options: TestGameOptions<World> = {}, definition = game) => testGame(definition, { random: seeded(11), ...options });
type T = ReturnType<typeof setup>;

/** Ada and Bob sit down, ready up and wait out the countdown. */
function playing(t: T = setup()) {
  const ada = t.join('Ada');
  const bob = t.join('Bob');
  t.command(ada, { type: 'ready' });
  t.command(bob, { type: 'ready' });
  t.run(RULES.countdownSeconds + 0.2);
  const active = currentTurn(t.world.turns!)!;
  return { t, ada, bob, active, other: active === ada ? bob : ada };
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
    const t = setup();
    const ada = t.join('Ada');
    const bob = t.join('Bob');
    const cy = t.join('Cy');
    expect([t.player(ada).seat, t.player(bob).seat, t.player(cy).seat]).toEqual([0, 1, -1]);
    expect(t.command(cy, { type: 'ready' })).toMatch(/watching/);
    t.command(ada, { type: 'ready' });
    t.tick();
    expect(t.world.match.phase).toBe('lobby');
    t.command(bob, { type: 'ready' });
    t.tick();
    expect(t.world.match.phase).toBe('countdown');
    expect(t.triggeredOf('match.countdown')).toEqual([{ seconds: RULES.countdownSeconds }]);
    t.run(RULES.countdownSeconds + 0.1);
    expect(t.world.match.phase).toBe('playing');
    expect(t.world.turns?.order).toEqual([ada, bob]);
    expect(t.triggeredOf('match.started')).toEqual([{ round: 1, players: [ada, bob] }]);
    expect(t.triggeredOf('turn.started')).toHaveLength(1);
    // The end of the turn is a timer saved in the world.
    expect(t.ctx.timeLeft('turn:end')).toBeGreaterThan(RULES.turnSeconds - 1);
  });

  test('only the active player fires, once per turn; the shot resolves, the retreat ends, the turn passes', () => {
    const { t, active, other } = playing();
    const spectator = t.join('Cy');
    expect(t.command(other, { type: 'fire', power: 1 })).toMatch(/Not your turn/);
    expect(t.command(spectator, { type: 'fire', power: 1 })).toMatch(/Not your turn/);
    expect(t.command(active, { type: 'fire', power: 0.6 })).toBeUndefined();
    expect(t.command(active, { type: 'fire', power: 0.6 })).toMatch(/already/);
    expect(Object.keys(t.world.projectiles)).toHaveLength(1);
    expect(t.world.turnPhase).toBe('flight');
    expect(t.ctx.timeLeft('turn:end')).toBeUndefined();
    expect(t.events).toContainEqual({ name: 'shell.fired', data: { player: active, weapon: 'shell', power: 0.6 } });

    t.run(12, () => t.world.turnPhase === 'retreat');
    expect(Object.keys(t.world.projectiles)).toHaveLength(0);
    expect(t.triggeredOf('shell.impact')).toHaveLength(1);
    expect(t.triggeredOf('shell.exploded')).toHaveLength(1);
    expect(t.triggeredOf('turn.resolved')).toEqual([{ player: active, turn: 1 }]);
    expect(t.ctx.timeLeft('turn:end')).toBeCloseTo(RULES.retreatSeconds, 1);
    expect(currentTurn(t.world.turns!)).toBe(active);

    t.run(RULES.retreatSeconds + 0.1);
    expect(currentTurn(t.world.turns!)).toBe(other);
    expect(t.world.turnPhase).toBe('aim');
    expect(t.triggeredOf('turn.started')).toHaveLength(2);
  });

  test('an idle turn times out (timer) and the wind is rerolled', () => {
    const { t, active, other } = playing();
    t.run(RULES.turnSeconds - 1);
    expect(currentTurn(t.world.turns!)).toBe(active);
    t.run(1.1);
    expect(t.triggeredOf('turn.expired')).toEqual([{ turn: 1 }]);
    expect(currentTurn(t.world.turns!)).toBe(other);
    const started = t.triggeredOf('turn.started') as Array<{ wind: number }>;
    expect(started).toHaveLength(2);
    expect(started[1].wind).toBe(t.world.wind);
  });

  test('a direct hit hurts through shell.damage; a lethal one ends the round', () => {
    const { t, active, other } = playing();
    const target = t.player(other);
    t.sim().explode({ x: target.x, z: target.z + 0.8 }, 2.6, 35, active, 'shell');
    t.tick();
    expect(target.hp).toBe(RULES.hp - 35);
    expect(t.triggeredOf('player.hit')).toEqual([{ player: other, by: active, weapon: 'shell', damage: 35 }]);
    t.sim().explode({ x: target.x, z: target.z + 0.8 }, 2.6, 500, active, 'shell');
    t.tick();
    expect(t.triggeredOf('player.died')).toEqual([{ player: other, by: active, cause: 'shell' }]);
    expect(t.world.match.phase).toBe('ended');
    expect(t.world.match.winner).toBe(active);
    expect(t.player(active).wins).toBe(1);
    expect(t.triggeredOf('match.ended')).toEqual([{ round: 1, winner: active, reason: 'last standing' }]);
    expect(t.ctx.timers('turn:')).toBe(0);
  });

  test('weather module: the wind.strength modifier', () => {
    const t = setup();
    expect(t.ctx.modify('wind.strength', 4, { player: 'x', turn: 1 })).toBe(2);
    expect(t.ctx.modify('wind.strength', 4, { player: 'x', turn: 2 })).toBe(4);
    expect(t.ctx.modify('wind.strength', 4, { player: 'x', turn: 4 })).toBe(6);
  });

  test('cluster module: its shell.impact handler adds five bomblets, and the turn waits for them', () => {
    const { t, active } = playing();
    t.command(active, { type: 'weapon', id: 'cluster' });
    t.command(active, { type: 'fire', power: 0.7 });
    t.run(12, () => t.triggeredOf('shell.impact').length > 0);
    expect(Object.values(t.world.projectiles).filter(p => p.kind === 'cluster-bomblet')).toHaveLength(5);
    expect(t.world.turnPhase).toBe('flight');
    t.run(12, () => t.world.turnPhase === 'retreat');
    const exploded = t.triggeredOf('shell.exploded') as Array<{ weapon: string }>;
    expect(exploded.map(e => e.weapon)).toEqual(['cluster', ...Array(5).fill('cluster-bomblet')]);
    expect(t.player(active).ammo.cluster).toBe(0);
    expect(t.command(active, { type: 'fire', power: 1 })).toMatch(/already/);
  });

  test('a module that throws is switched off; its shell still explodes and the round goes on', () => {
    // The cluster module's impact handler breaks (as a bad push would).
    const broken = {
      ...registry,
      handlers: registry.handlers.map(h => (h.owner === 'cluster' ? { owner: h.owner, value: { event: h.value.event, run: () => { throw new Error('bomblets jammed'); } } } : h)),
    };
    const { t, active, other } = playing(setup({ strict: false }, { ...game, features: broken }));
    t.command(active, { type: 'weapon', id: 'cluster' });
    t.command(active, { type: 'fire', power: 0.7 });
    t.run(12, () => t.world.turnPhase === 'retreat');
    expect(t.disabled.cluster).toMatch(/bomblets jammed/);
    expect(t.feed().some(text => text.includes('switched off'))).toBe(true);
    expect(t.world.pause).toBeNull();
    expect((t.triggeredOf('shell.exploded') as Array<{ weapon: string }>).map(e => e.weapon)).toEqual(['cluster']);
    t.run(RULES.retreatSeconds + 0.1);
    expect(currentTurn(t.world.turns!)).toBe(other);
    expect(t.command(other, { type: 'fire', power: 0.6 })).toBeUndefined();
    t.run(12, () => t.world.turnPhase === 'retreat');
    expect(t.triggeredOf('shell.exploded')).toHaveLength(2);
  });

  test('a throwing onImpact hook switches its module off and falls back to the default explosion', () => {
    const mortar = registry.kinds.weapons.mortar;
    mortar.onImpact = () => { throw new Error('dud'); };
    try {
      const { t, active } = playing(setup({ strict: false }));
      t.command(active, { type: 'weapon', id: 'mortar' });
      t.command(active, { type: 'fire', power: 0.7 });
      t.run(12, () => t.world.turnPhase === 'retreat');
      expect(t.disabled.artillery).toMatch(/dud/);
      expect(t.triggeredOf('shell.exploded')).toEqual([expect.objectContaining({ weapon: 'mortar', radius: mortar.radius })]);
    } finally {
      delete mortar.onImpact;
    }
  });

  test('a human takes the seat of a bot; the running round is called off', () => {
    const t = setup();
    const ada = t.join('Ada');
    const bot = t.addBot();
    expect(t.player(bot).seat).toBe(1);
    t.tick();
    t.command(ada, { type: 'ready' });
    t.run(RULES.countdownSeconds + 0.2);
    expect(t.world.match.phase).toBe('playing');
    const bob = t.join('Bob');
    expect(t.player(bot)).toBeUndefined();
    expect(t.player(bob).seat).toBe(1);
    expect(t.world.match.phase).toBe('lobby');
    expect(t.world.turns).toBeNull();
    expect(t.ctx.timers('turn:')).toBe(0);
    expect(t.triggeredOf('match.ended')).toEqual([{ round: 1, winner: null, reason: 'player joined' }]);
  });

  test('two engine bots play a whole round to a winner', () => {
    const t = setup();
    const a = t.addBot();
    const b = t.addBot();
    const wins = () => t.player(a).wins + t.player(b).wins;
    t.run(900, () => wins() > 0);
    expect(wins()).toBe(1);
    expect(t.world.match.phase).toBe('ended');
    expect(t.triggeredOf('match.ended')).toEqual([expect.objectContaining({ round: 1, reason: 'last standing' })]);
    expect(t.triggeredOf('player.hit').length).toBeGreaterThan(0);
    expect(t.triggeredOf('turn.started').length).toBeGreaterThan(2);
    // Bots ready up again: the rematch starts by itself.
    t.run(RULES.countdownSeconds + 0.5);
    expect(t.world.match.round).toBe(2);
    expect(t.player(a).hp + t.player(b).hp).toBe(RULES.hp * 2);
  }, 60000);

  test('a save from schema 1 (shotFired / retreatUntil, no timers) is migrated and keeps playing', () => {
    const { t, active, other } = playing();
    const old = structuredClone(t.world) as unknown as Record<string, unknown>;
    // What a schema-1 checkpoint looked like mid-retreat.
    Object.assign(old, { schema: 1, shotFired: true, retreatUntil: t.world.time + 2 });
    delete old.turnPhase;
    delete old.schedule;
    delete old.tick;
    const loaded = setup({ world: old });
    expect(loaded.world.schema).toBe(2);
    expect(loaded.world.turnPhase).toBe('retreat');
    expect('shotFired' in loaded.world).toBe(false);
    expect(loaded.ctx.timeLeft('turn:end')).toBeCloseTo(2, 1);
    loaded.run(2.1);
    expect(currentTurn(loaded.world.turns!)).toBe(other);
    expect(loaded.command(other, { type: 'fire', power: 0.5 })).toBeUndefined();
    expect(currentTurn(loaded.world.turns!)).not.toBe(active);
  });
});

describe('determinism', () => {
  test('a recorded bot-vs-bot round with a spectator replays exactly', () => {
    const t = testGame(game, { seed: 21, record: true });
    const ada = t.join('Ada');
    t.addBot('Rival'); t.addBot('Other');
    t.command(ada, { type: 'ready' });
    t.run(120);
    const result = replay(game, JSON.parse(JSON.stringify(t.recording())));
    expect(result.diverged).toBeUndefined();
    expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
  });
});
