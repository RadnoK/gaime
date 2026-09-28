import { describe, expect, test } from 'vitest';
import { addTimer, baseWorld, cancelTimer, cancelTimers, countTimers, createRegistry, createSchedule, seeded, takeDue, timerLeft, type BasePlayer, type BaseWorld, type FeatureModule } from '@gaime/core';
import { defineGame, testGame, testContext, type GameContext } from '@gaime/core/server';

describe('schedule', () => {
  test('fires in time order, ties by creation; replaces and cancels by key', () => {
    const s = createSchedule();
    addTimer(s, 0, 3, 'c');
    addTimer(s, 0, 1, 'a');
    addTimer(s, 0, 1, 'b');
    addTimer(s, 0, 2, 'x', undefined, { key: 'k' });
    addTimer(s, 0, 5, 'y', undefined, { key: 'k' });              // replaces x
    expect(countTimers(s)).toBe(4);
    expect(timerLeft(s, 'k', 1)).toBe(4);
    expect(takeDue(s, 2.5).map(t => t.event)).toEqual(['a', 'b']);
    expect(cancelTimer(s, 'k')).toBe(true);
    expect(takeDue(s, 10).map(t => t.event)).toEqual(['c']);
    expect(countTimers(s)).toBe(0);
  });

  test('recurring timers keep their rhythm, skip missed intervals and stop after `times`', () => {
    const s = createSchedule();
    addTimer(s, 0, 1, 'tick', undefined, { key: 'r', every: 1 });
    addTimer(s, 0, 1, 'three', undefined, { every: 1, times: 3 });
    const fired: string[] = [];
    for (let t = 1; t <= 4; t++) fired.push(...takeDue(s, t).map(x => x.event));
    expect(fired.filter(e => e === 'three')).toHaveLength(3);
    expect(fired.filter(e => e === 'tick')).toHaveLength(4);
    // A long pause: fires once, then a full interval later.
    expect(takeDue(s, 20).map(x => x.event)).toEqual(['tick']);
    expect(timerLeft(s, 'r', 20)).toBe(1);
  });

  test('prefix cancel and compaction keep the heap small', () => {
    const s = createSchedule();
    for (let i = 0; i < 500; i++) addTimer(s, 0, i, 'e', { i }, { key: `enemy:${i}:burn` });
    expect(cancelTimers(s, 'enemy:1')).toBe(111);                  // 1, 10-19, 100-199
    for (let i = 0; i < 300; i++) cancelTimer(s, `enemy:${i}:burn`);
    expect(s.heap.length).toBeLessThan(400);
    expect(takeDue(s, 1000)).toHaveLength(200);
  });

  test('is plain JSON: survives a save round trip', () => {
    const s = createSchedule();
    addTimer(s, 0, 2, 'later', { id: 'e1' }, { key: 'k' });
    const copy = JSON.parse(JSON.stringify(s));
    expect(takeDue(copy, 2)).toEqual([expect.objectContaining({ event: 'later', data: { id: 'e1' } })]);
  });
});

// ── a tiny game exercising the engine ─────────────────────────────────

interface Player extends BasePlayer { hp: number; score: number }
interface World extends BaseWorld<Player> { log: string[]; kills: number }
type Events = { 'enemy.died': { by: string }; 'bonus': { by: string }; 'ping': null; 'loop': null };
type Sim = { world: World; ctx: GameContext<World, Events>; dt: number };
type Feature = FeatureModule<{ none: { id: string } }, Sim, Events>;

function makeGame(modules: Record<string, Feature> = {}) {
  const registry = createRegistry<{ none: { id: string } }>(
    Object.fromEntries(Object.entries(modules).map(([id, feature]) => [`../features/${id}/server.ts`, { default: feature }])),
    { kinds: ['none'] },
  );
  return defineGame<World, { hit?: boolean }, Sim, Events>({
    name: 'engine-test',
    features: registry,
    createWorld: () => ({ ...baseWorld(1), log: [], kills: 0 }),
    createPlayer: (_world, id, name) => ({ id, name, online: true, data: {}, hp: 10, score: 0 }),
    parseInput: raw => raw as { hit?: boolean },
    sim: (ctx, dt) => ({ world: ctx.world, ctx, dt }),
    step(world, inputs, _dt, ctx) {
      for (const [id, input] of Object.entries(inputs)) if (input.hit) { world.kills++; ctx.trigger('enemy.died', { by: id }); }
    },
    on: {
      'enemy.died': ({ by }, sim) => { sim.world.log.push(`game:${by}`); sim.world.players[by].score += sim.ctx.modify('score', 10, { by }); },
    },
    command(world, id, command, ctx) {
      if (command.type === 'later') { ctx.after(1, 'ping', null, { key: `player:${id}:ping` }); return; }
      return `Unknown command ${command.type}.`;
    },
  });
}

describe('engine', () => {
  test('events run game handlers first, then modules in order; chained events in the same tick', () => {
    const game = makeGame({
      bonus: { on: { 'enemy.died': (e, sim) => { sim.world.log.push(`bonus:${e.by}`); sim.ctx.trigger('bonus', e); } } },
      zlast: { on: { bonus: (e, sim) => { sim.world.log.push(`zlast:${e.by}`); } } },
    });
    const t = testGame(game);
    const ada = t.join('Ada');
    t.input(ada, { hit: true });
    t.tick();
    expect(t.world.log).toEqual([`game:${ada}`, `bonus:${ada}`, `zlast:${ada}`]);
    expect(t.triggeredOf('bonus')).toEqual([{ by: ada }]);
  });

  test('modifiers chain in order and a failing one is skipped', () => {
    const game = makeGame({
      bad: { modify: { score: () => { throw new Error('nope'); } } },
      double: { modify: { score: value => value * 2 } },
      plus: { modify: { score: value => value + 1 } },
    });
    const t = testGame(game, { strict: false });
    const ada = t.join('Ada');
    t.input(ada, { hit: true });
    t.tick();
    expect(t.player(ada).score).toBe(21);
    expect(Object.keys(t.disabled)).toEqual(['bad']);
  });

  test('timers are saved in the world, fire events after world time passes and stop while paused', () => {
    const t = testGame(makeGame({ pong: { on: { ping: (_e, sim) => { sim.world.log.push('pong'); } } } }));
    const ada = t.join('Ada');
    t.command(ada, { type: 'later' });
    expect(t.ctx.timeLeft(`player:${ada}:ping`)).toBeCloseTo(1);
    t.world.pause = { reason: 'host' };
    t.run(2);
    expect(t.world.log).toEqual([]);
    t.world.pause = null;
    t.run(1.05);
    expect(t.world.log).toEqual(['pong']);
    // A removed player's timers go with them.
    t.command(ada, { type: 'later' });
    t.remove(ada);
    expect(t.ctx.timers('player:')).toBe(0);
  });

  test('ctx.every is idempotent for the same key, event and interval', () => {
    const t = testGame(makeGame());
    const key = t.ctx.every(2, 'ping', null, { key: 'spawner' });
    t.run(1);
    t.ctx.every(2, 'ping', null, { key });                          // e.g. called again by prepare after a reload
    expect(t.ctx.timeLeft(key)).toBeCloseTo(1, 1);
    t.run(1.02);
    expect(t.triggeredOf('ping')).toHaveLength(1);
  });

  test('systems run by phase around step; periodic systems are staggered and get their real dt', () => {
    const order: string[] = [];
    const dts: number[] = [];
    const game = makeGame({
      a: { systems: [{ id: 'late', phase: 'late', run: () => { order.push('late'); } }, { id: 'input', phase: 'input', run: () => { order.push('input'); } }] },
      b: { systems: [{ id: 'think', every: 0.5, run: (_sim, dt) => { dts.push(dt); } }] },
    });
    const t = testGame({ ...game, step: (...args) => { order.push('step'); game.step!(...args); } });
    t.tick();
    expect(order).toEqual(['input', 'step', 'late']);
    t.run(3);
    expect(dts.length).toBeGreaterThanOrEqual(5);
    expect(dts.length).toBeLessThanOrEqual(7);
    for (const dt of dts.slice(1)) expect(dt).toBeCloseTo(0.5, 1);
  });

  test('module commands: routed by type, isolated, duplicates rejected', () => {
    const game = makeGame({ teleport: { commands: { 'teleport-go': (id, command, sim) => { sim.world.log.push(`go:${id}:${command.to}`); return 'whoosh'; } } } });
    const t = testGame(game);
    const ada = t.join('Ada');
    expect(t.command(ada, { type: 'teleport-go', to: 'moon' })).toBe('whoosh');
    expect(t.world.log).toEqual([`go:${ada}:moon`]);
    expect(t.command(ada, { type: 'nope' })).toBe('Unknown command nope.');
    expect(() => makeGame({ a: { commands: { x: () => {} } }, b: { commands: { x: () => {} } } })).toThrow(/already handled by a/);
  });

  test('a failing module is switched off; the game keeps running', () => {
    const game = makeGame({
      broken: { on: { 'enemy.died': () => { throw new Error('boom'); } }, systems: [{ id: 's', run: () => {} }] },
      fine: { on: { 'enemy.died': (_e, sim) => { sim.world.log.push('fine'); } } },
    });
    const t = testGame(game, { strict: false });
    const ada = t.join('Ada');
    t.input(ada, { hit: true });
    t.run(0.2);
    expect(t.disabled).toEqual({ broken: 'boom' });
    expect(t.world.pause).toBeNull();
    expect(t.world.log.filter(l => l === 'fine').length).toBeGreaterThan(1);
    expect(t.feed().some(text => text.includes('Module "broken" was switched off'))).toBe(true);
  });

  test('an error in game code pauses the game; strict tests throw instead', () => {
    const game = { ...makeGame(), step: () => { throw new Error('bad step'); } };
    const loose = testGame(game, { strict: false });
    loose.tick();
    expect(loose.world.pause).toEqual({ reason: 'error', message: 'bad step' });
    expect(() => testGame(game).tick()).toThrow('bad step');
  });

  test('an event storm (a handler re-triggering itself) is stopped', () => {
    const t = testGame(makeGame({ loop: { on: { loop: (_e, sim) => { sim.ctx.trigger('loop', null); } } } }), { strict: false });
    t.join('Ada');
    t.ctx.trigger('loop', null);
    t.tick();
    expect(t.disabled.loop).toMatch(/Event storm/);
  });

  test('forwarded events reach clients; ctx.emit too', () => {
    const game = { ...makeGame(), network: { events: ['enemy.died'] } };
    const t = testGame(game);
    const ada = t.join('Ada');
    t.input(ada, { hit: true });
    t.tick();
    t.ctx.emit('sound', { kind: 'boom' }, ada);
    expect(t.events).toEqual([{ name: 'enemy.died', data: { by: ada } }, { name: 'sound', data: { kind: 'boom' }, playerId: ada }]);
  });

  test('old saves get the engine fields; the clock is deterministic', () => {
    const game = makeGame();
    const old = { schema: 1, version: 'x', time: 5, pause: null, hostId: null, players: {}, feed: [], seq: 3, log: [], kills: 0 };
    const t = testGame(game, { world: old, random: seeded(1) });
    expect(t.world.schedule.heap).toEqual([]);
    t.tick(30);
    expect(t.world.tick).toBe(30);
    expect(t.world.time).toBeCloseTo(6);
  });

  test('testContext: triggers are recorded and timers fire with advance()', () => {
    const world = { ...baseWorld(1), log: [], kills: 0 } as World;
    const { ctx, triggered, advance } = testContext(world);
    ctx.after(0.5, 'ping', null);
    ctx.trigger('bonus', { by: 'x' });
    expect(triggered).toEqual([{ event: 'bonus', data: { by: 'x' } }]);
    advance(1);
    expect(triggered.map(t => t.event)).toEqual(['bonus', 'ping']);
  });
});
