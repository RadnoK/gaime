import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testGame } from '@gaime/core/server';
import { game } from '../src/server/game';
import { registry } from '../src/server/registry';
import { createWorld, SCHEMA } from '../src/server/simulation';
import { RULES } from '../src/shared/rules';
import type { Events, Sim } from '../src/shared/types';

// testGame runs the same engine as the server (clock, timers, events, systems, modules) without a network.
const setup = (options: { strict?: boolean; world?: unknown } = {}) => testGame(game, { random: seeded(7), ...options });

/** A round with one host. `act` calls Sim helpers from the test and dispatches the events they trigger. */
function round() {
  const t = setup();
  const ola = t.join('Ola');
  expect(t.command(ola, { type: 'start' })).toBeUndefined();
  const act = (run: (sim: Sim) => void) => t.engine.outside(() => run(t.sim()));
  /** Kill every enemy as it arrives until the wave is cleared. */
  const clearWave = () => {
    const ticks = t.run(60, () => { act(sim => { for (const enemy of sim.enemies()) sim.hurtEnemy(enemy, 1e6); }); return t.world.phase !== 'fight'; });
    expect(t.world.phase).toBe('break');
    return ticks;
  };
  return { t, ola, act, clearWave };
}

describe('starter', () => {
  test('every feature module loads and the catalog lists them', () => {
    expect(registry.lists.enemies.length).toBeGreaterThan(0);
    expect(registry.lists.waves.length).toBeGreaterThan(0);
    for (const id of RULES.defaultAbilities) expect(registry.kinds.abilities[id]).toBeDefined();
    expect(JSON.parse(JSON.stringify(createWorld()))).toEqual(createWorld());
    const t = setup();
    expect(t.world.catalog.length).toBe(registry.catalog.length);
  });

  test('players move but stay inside the arena and outside the crystal', () => {
    const t = setup();
    const ola = t.join('Ola');
    t.input(ola, { mx: 1, mz: 0, ax: 50, az: 0, fire: false });
    t.run(10);
    expect(Math.hypot(t.player(ola).x, t.player(ola).z)).toBeLessThanOrEqual(RULES.arenaRadius);
    t.input(ola, { mx: -1, mz: 0, ax: 0, az: 0, fire: false });
    t.run(10);
    expect(Math.hypot(t.player(ola).x, t.player(ola).z)).toBeGreaterThanOrEqual(RULES.crystalRadius);
  });

  test('only the host starts a round; a wave schedules its enemies as timers', () => {
    const t = setup();
    const ola = t.join('Ola');
    const ala = t.join('Ala');
    expect(t.command(ala, { type: 'start' })).toMatch(/host/);
    expect(t.command(ola, { type: 'start' })).toBeUndefined();
    expect(t.world.phase).toBe('fight');
    expect(t.triggeredOf('wave.started')).toEqual([expect.objectContaining({ wave: 1 })]);
    const pending = t.ctx.timers('spawn:');
    expect(pending).toBeGreaterThan(0);
    expect(Object.keys(t.world.enemies)).toHaveLength(0);
    t.run(3);
    expect(t.ctx.timers('spawn:')).toBeLessThan(pending);
    expect(t.triggeredOf('enemy.spawned').length).toBe(Object.keys(t.world.enemies).length);
    expect(t.events.map(e => e.name)).toContain('wave.started');
  });

  test('shooting kills an enemy: enemy.died carries the reward, the game scores it', () => {
    const { t, ola } = round();
    t.run(1);
    const enemy = Object.values(t.world.enemies)[0];
    const def = registry.kinds.enemies[enemy.kind];
    Object.assign(t.player(ola), { x: enemy.x - 3, z: enemy.z });
    t.input(ola, { mx: 0, mz: 0, ax: enemy.x, az: enemy.z, fire: true });
    // Hold still next to it: only this enemy is in the line of fire at first.
    t.run(10, () => !t.world.enemies[enemy.id]);
    expect(t.world.enemies[enemy.id]).toBeUndefined();
    const died = t.triggeredOf('enemy.died') as Array<Events['enemy.died']>;
    expect(died).toContainEqual(expect.objectContaining({ enemy: enemy.id, kind: enemy.kind, by: ola, reward: def.reward }));
    expect(t.player(ola).kills).toBe(died.filter(d => d.by === ola).length);
    expect(t.world.score).toBe(died.reduce((sum, d) => sum + d.reward, 0));
  });

  test('a wave is cleared when no enemy and no spawn timer is left; the next one starts after the break', () => {
    const { t, clearWave } = round();
    clearWave();
    expect(t.ctx.timers('spawn:')).toBe(0);
    expect(t.triggeredOf('wave.cleared')).toEqual([{ wave: 1, bonus: 50 }]);
    expect(t.ctx.timeLeft('wave:next')).toBeCloseTo(RULES.breakSeconds, 1);
    expect(t.world.nextWaveAt).toBeCloseTo(t.world.time + RULES.breakSeconds, 5);
    t.run(RULES.breakSeconds + 0.1);
    expect(t.world.phase).toBe('fight');
    expect(t.world.wave).toBe(2);
  });

  test('field-kit (`on`): clearing a wave restores 30 HP to everyone standing', () => {
    const { t, ola, clearWave } = round();
    t.player(ola).hp = 50;
    clearWave();
    expect(t.player(ola).hp).toBe(80);
  });

  test('frost (`modify`): a chilled enemy moves at 20% speed for 3 s', () => {
    const { t, ola, act } = round();
    act(sim => sim.spawn('beetle', { x: 20, z: 0 }));
    t.tick();
    const spawned = (t.triggeredOf('enemy.spawned') as Array<Events['enemy.spawned']>).find(e => e.x === 20)!;
    const beetle = t.world.enemies[spawned.enemy];
    const speed = registry.kinds.enemies.beetle.speed;
    expect(t.sim().enemySpeed(beetle)).toBeCloseTo(speed);
    t.command(ola, { type: 'equip', slot: 0, ability: 'frost-nova' });
    Object.assign(t.player(ola), { x: beetle.x - 3, z: beetle.z });
    expect(t.command(ola, { type: 'cast', slot: 0, x: 0, z: 0 })).toBeUndefined();
    expect(beetle.hp).toBe(beetle.maxHp - 20);
    expect(t.sim().enemySpeed(beetle)).toBeCloseTo(speed * 0.2);
    t.run(3.1);
    expect(t.sim().enemySpeed(beetle)).toBeCloseTo(speed);
  });

  test('crystal-golem (`systems`, every 6 s): golems slam players within 5 m', () => {
    const slam = registry.systems.find(system => system.owner === 'crystal-golem' && system.value.id === 'slam')!;
    expect(slam.value.every).toBe(6);
    const { t, ola, act } = round();
    act(sim => sim.spawn('golem', { x: 20, z: 0 }));
    t.tick();
    const golem = t.sim().enemies().find(e => e.kind === 'golem')!;
    Object.assign(t.player(ola), { x: golem.x - 4, z: golem.z });
    act(sim => slam.value.run(sim, 6));
    expect(t.player(ola).hp).toBe(t.player(ola).maxHp - 30);
    // Driven by the engine: one slam per 6 s of game time.
    Object.assign(t.player(ola), { x: -20, z: 0 });
    const slams: Record<number, number> = {};
    const start = t.world.time;
    t.run(13, () => { for (const e of t.world.effects) if (e.type === 'pulse' && e.color === '#8f7bff' && e.time > start) slams[e.id] ??= e.time; return false; });
    const times = Object.values(slams).sort((a, b) => a - b);
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(6, 1);
  });

  test('a downed player respawns by a timer', () => {
    const { t, ola, act } = round();
    act(sim => sim.hurtPlayer(t.player(ola), 1000));
    expect(t.player(ola).respawnAt).toBeGreaterThan(0);
    expect(t.triggeredOf('player.downed')).toEqual([expect.objectContaining({ playerId: ola })]);
    expect(t.events).toContainEqual({ name: 'player.downed', data: expect.objectContaining({ playerId: ola }) });
    expect(t.ctx.timeLeft(`player:${ola}:respawn`)).toBeCloseTo(RULES.respawnSeconds, 1);
    t.run(RULES.respawnSeconds + 0.1);
    expect(t.player(ola).respawnAt).toBe(0);
    expect(t.player(ola).hp).toBe(t.player(ola).maxHp);
    expect(t.triggeredOf('player.respawned')).toEqual([{ playerId: ola }]);
  });

  test('an undefended crystal falls and anyone can start a new round', () => {
    const { t, ola } = round();
    t.leave(ola);
    t.run(600, () => t.world.phase === 'lost');
    expect(t.world.phase).toBe('lost');
    expect(t.triggeredOf('round.lost')).toHaveLength(1);
    expect(t.ctx.timers('spawn:')).toBe(0);
    t.join('Ola', ola);
    expect(t.command(ola, { type: 'restart' })).toBeUndefined();
    expect(t.world.phase).toBe('lobby');
    expect(t.world.crystal.hp).toBe(RULES.crystalHp);
  });

  test('abilities respect cooldowns and equipping swaps slots', () => {
    const t = setup();
    const ola = t.join('Ola');
    const player = t.player(ola);
    t.command(ola, { type: 'cast', slot: 0, x: 5, z: 5 });
    expect(player.cooldowns[player.abilities[0]]).toBeGreaterThan(t.world.time);
    expect(t.triggeredOf('ability.cast')).toEqual([expect.objectContaining({ playerId: ola, ability: player.abilities[0] })]);
    t.command(ola, { type: 'cast', slot: 0, x: 5, z: 5 });
    expect(t.triggeredOf('ability.cast')).toHaveLength(1);
    t.command(ola, { type: 'equip', slot: 0, ability: player.abilities[1] });
    expect(player.abilities[0]).not.toBe(player.abilities[1]);
  });

  test('a failing module is switched off; its enemies fall back to the default AI and the game runs on', () => {
    const runner = registry.kinds.enemies.runner;
    runner.tick = () => { throw new Error('boom'); };
    try {
      const t = setup({ strict: false });
      const ola = t.join('Ola');
      t.command(ola, { type: 'start' });
      t.run(8);
      expect(t.disabled.grunts).toMatch(/boom/);
      expect(t.world.pause).toBeNull();
      const runners = Object.values(t.world.enemies).filter(e => e.kind === 'runner');
      const before = runners.map(e => Math.hypot(e.x, e.z));
      t.run(1);
      const after = runners.map(e => Math.hypot(e.x, e.z));
      expect(after.some((d, i) => d < before[i])).toBe(true);
      expect(t.feed().some(text => text.includes('grunts'))).toBe(true);
    } finally {
      delete runner.tick;
    }
  });

  test('state stays valid after a feature disappears (hot reload without it)', () => {
    const t = setup();
    const ola = t.join('Ola');
    t.world.enemies.ghost = { id: 'ghost', kind: 'removed-enemy', x: 0, z: 0, angle: 0, hp: 1, maxHp: 1, data: {} };
    t.player(ola).abilities = ['removed-ability', 'pulse'];
    t.engine.prepare('TEST');
    expect(t.world.enemies.ghost).toBeUndefined();
    expect(registry.kinds.abilities[t.player(ola).abilities[0]]).toBeDefined();
  });

  test('an old save (schema 1) with pending spawns, a downed player and a break is migrated to timers', () => {
    const old = JSON.parse(JSON.stringify(createWorld()));
    delete old.schedule;
    Object.assign(old, {
      schema: 1, time: 100, phase: 'fight', wave: 2, seq: 50,
      spawns: [
        { id: 41, enemy: 'beetle', at: 101, x: 20, z: 0 },
        { id: 42, enemy: 'removed-enemy', at: 101, x: 0, z: 20 },
        { id: 'bad', enemy: 'beetle' },
      ],
      players: {
        p1: { id: 'p1', name: 'Ola', online: false, data: {}, x: 5, z: 5, angle: 0, hp: 0, maxHp: 100, color: '#fff', respawnAt: 103, kills: 3, abilities: ['dash', 'pulse'], cooldowns: {}, nextShotAt: 0 },
      },
    });
    const t = setup({ world: old });
    expect(t.world.schema).toBe(SCHEMA);
    expect('spawns' in t.world).toBe(false);
    expect(t.ctx.timers('spawn:')).toBe(2);
    expect(t.ctx.timeLeft('player:p1:respawn')).toBeCloseTo(3);
    t.run(1.1);
    expect(t.world.enemies.e41).toMatchObject({ kind: 'beetle' });
    expect(Object.keys(t.world.enemies)).toEqual(['e41']);
    t.run(2);
    expect(t.player('p1').respawnAt).toBe(0);

    const broken = { ...JSON.parse(JSON.stringify(old)), phase: 'break', nextWaveAt: 102, spawns: [] };
    const u = setup({ world: broken });
    u.run(2.1);
    expect(u.world.phase).toBe('fight');
    expect(u.world.wave).toBe(3);
  });

  test('bots defend the crystal on their own', () => {
    const t = setup();
    t.join('Ola');
    const bots = [t.addBot(), t.addBot(), t.addBot()];
    t.command(t.world.hostId!, { type: 'start' });
    t.run(90, () => t.triggeredOf('wave.cleared').length > 0);
    expect(bots.reduce((sum, bot) => sum + t.player(bot).kills, 0)).toBeGreaterThan(0);
    expect(t.triggeredOf('wave.cleared').length).toBeGreaterThan(0);
    expect(t.world.crystal.hp).toBeGreaterThan(0);
  });

  test('scoreboard request and the /report worker job', async () => {
    const { t, ola } = round();
    t.run(3);
    expect(await t.request(ola, 'scoreboard')).toEqual([{ name: 'Ola', kills: 0, online: true }]);
    expect(t.chat(ola, '/report')).toBe('Analysing…');
    await t.flushJobs();
    expect(t.feed().some(text => text.startsWith('📡 Report: biggest threat'))).toBe(true);
  });
});
