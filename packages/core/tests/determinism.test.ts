import { describe, expect, test } from 'vitest';
import { baseWorld, createRegistry, type BasePlayer, type BaseWorld, type FeatureModule } from '@gaime/core';
import { defineGame, replay, testGame, type GameContext } from '@gaime/core/server';

interface Player extends BasePlayer { x: number; z: number; score: number }
interface Rock { id: string; x: number; z: number }
interface World extends BaseWorld<Player> { rocks: Record<string, Rock>; log: string[] }
type Input = { mx: number };
type Feature = FeatureModule<{ none: { id: string } }, GameContext<World>>;

function makeGame(modules: Record<string, Feature> = {}) {
  const registry = createRegistry<{ none: { id: string } }>(
    Object.fromEntries(Object.entries(modules).map(([id, feature]) => [`../features/${id}/server.ts`, { default: feature }])),
    { kinds: ['none'] },
  );
  return defineGame<World, Input, GameContext<World>>({
    name: 'determinism',
    features: registry,
    spatial: { rocks: { cell: 2 }, players: {} },
    createWorld: () => ({ ...baseWorld(1), rocks: {}, log: [] }),
    createPlayer: (_w, id, name, ctx) => ({ id, name, online: true, data: {}, x: ctx.random() * 10, z: 0, score: 0 }),
    parseInput: raw => raw as Input,
    step(world, inputs, dt) { for (const [id, input] of Object.entries(inputs)) world.players[id].x += input.mx * 5 * dt; },
    systems: [
      { id: 'rocks', every: 0.5, run: ctx => { const id = `r${ctx.nextId()}`; ctx.world.rocks[id] = { id, x: ctx.random() * 20 - 10, z: ctx.random() * 20 - 10 }; } },
      { id: 'collect', run: ctx => {
        for (const player of Object.values(ctx.world.players)) for (const rock of ctx.near<Rock>('rocks', player, 1.5)) {
          delete ctx.world.rocks[rock.id]; player.score++; ctx.trigger('rock.taken', { by: player.id });
        }
      } },
    ],
    on: { 'rock.taken': ({ by }, ctx) => { if (ctx.random() < 0.3) ctx.after(1, 'bonus:late', { by }); } },
    command(world, id, command, ctx) {
      if (command.type === 'shuffle') { for (const p of Object.values(world.players)) p.x = ctx.random() * 10; return; }
      if (command.type === 'job') { ctx.job(Promise.resolve(ctx.random()), (w, value) => { w.log.push(`job ${Math.round((value as number) * 1000)}`); }); return; }
    },
    bot: (world, id, ctx) => ({ mx: ctx.random() * 2 - 1 }),
    admin: { clear: { description: 'clear the rocks', run: world => { world.rocks = {}; } } },
  });
}

describe('spatial index', () => {
  test('near/nearest use current positions and skip removed entities', () => {
    const t = testGame(makeGame(), { seed: 1 });
    t.world.rocks = { a: { id: 'a', x: 0, z: 0 }, b: { id: 'b', x: 3, z: 0 }, c: { id: 'c', x: 50, z: 50 } };
    t.tick();
    const origin = { x: 0.2, z: 0 };
    expect(t.ctx.near<Rock>('rocks', origin, 1).map(r => r.id)).toEqual(['a']);
    t.world.rocks.a.x = 0.9;                                       // moved within the tick: still found, at its new place
    delete t.world.rocks.b;
    expect(t.ctx.near<Rock>('rocks', origin, 5).map(r => r.id)).toEqual(['a']);
    expect(t.ctx.nearest<Rock>('rocks', { x: 40, z: 40 })?.id).toBe('c');   // unbounded search
    expect(() => t.ctx.near('players-typo', origin, 1)).toThrow(/not a spatial collection/);
  });

  test('resources live until the code is replaced', () => {
    const t = testGame(makeGame());
    let created = 0; let disposed = 0;
    const make = () => t.ctx.resource('cache', () => ({ n: ++created }), () => { disposed++; });
    expect(make()).toBe(make());
    t.engine.dispose();
    expect(disposed).toBe(1);
    expect(make().n).toBe(2);
  });
});

describe('determinism and replays', () => {
  test('the same seed gives the same game', () => {
    const run = () => { const t = testGame(makeGame(), { seed: 7 }); t.join('Ada'); t.addBot(); t.run(20); return JSON.stringify(t.world); };
    expect(run()).toBe(run());
  });

  test('a recorded session replays exactly: inputs, commands, bots, jobs, admin, leaves', async () => {
    const game = makeGame();
    const t = testGame(game, { seed: 3, record: true });
    const ada = t.join('Ada');
    const bob = t.join('Bob');
    t.addBot('Robo');
    for (let second = 0; second < 30; second++) {
      t.input(ada, { mx: Math.sin(second) });
      if (second % 7 === 0) t.command(bob, { type: 'shuffle' });
      if (second === 5) { t.command(ada, { type: 'job' }); await t.flushJobs(); }
      if (second === 10) t.admin('clear');
      if (second === 15) t.leave(bob);
      if (second === 20) t.chat(ada, 'hello');
      t.run(1);
    }
    const recording = t.recording();
    expect(recording.reason).toBe('test');
    const result = replay(game, JSON.parse(JSON.stringify(recording)));
    expect(result.diverged).toBeUndefined();
    expect(result.verified).toBeGreaterThan(3);
    expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
  });

  test('non-deterministic code is caught at the first check', () => {
    let calls = 0;
    const clean = makeGame();
    const sloppy = { ...clean, systems: [...clean.systems!, { id: 'sloppy', run: (ctx: GameContext<World>) => { if (++calls > 200) ctx.world.log.push('different'); } }] };
    const t = testGame(sloppy, { seed: 1, record: true });
    t.join('Ada');
    t.run(20);
    const result = replay(sloppy, t.recording());   // the counter keeps counting: the replay differs
    expect(result.diverged?.tick).toBeGreaterThan(0);
  });

  test('segments rotate and a long recording still replays', () => {
    const game = { ...makeGame(), record: { minutes: 0.05 } };
    const t = testGame(game, { seed: 5, record: true });
    t.join('Ada'); t.addBot();
    t.run(60);
    const recording = t.recording();
    expect(recording.segments.length).toBe(3);
    const result = replay(game, recording);
    expect(result.diverged).toBeUndefined();
    expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
  });
});

describe('module time budget', () => {
  const busy = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* burn */ } };

  test('a slow module gets its systems throttled, then relaxed; handlers keep running; replay follows', () => {
    let slow = true;
    const game = { ...makeGame({ heavy: { systems: [{ id: 'crunch', run: () => { if (slow) busy(4); } }], on: { 'rock.taken': () => {} } } }), budget: { moduleMs: 1 } };
    const t = testGame(game, { seed: 2, budget: true, record: true });
    t.join('Ada');
    t.run(2.1);
    expect(t.engine.throttle.heavy).toBe(4);
    expect(t.feed().some(text => text.includes('Module "heavy" is over its time budget'))).toBe(true);
    slow = false;
    t.run(6);
    expect(t.engine.throttle.heavy).toBeUndefined();
    const result = replay(game, t.recording());
    expect(result.diverged).toBeUndefined();
  });

  test('under heavy input a segment rotates early (bounded memory) and the recording still replays', () => {
    const game = makeGame();
    const t = testGame(game, { seed: 8, record: { maxEntries: 40 } });
    const ada = t.join('Ada'); const bob = t.join('Bob');
    for (let tick = 0; tick < 600; tick++) { t.input(ada, { mx: Math.sin(tick) }); t.input(bob, { mx: Math.cos(tick) }); t.tick(); }
    const recording = t.recording();
    expect(recording.segments).toHaveLength(3);
    expect(recording.segments.every(segment => segment.entries.length <= 40)).toBe(true);
    const result = replay(game, recording);
    expect(result.diverged).toBeUndefined();
    expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
  });
});
