import { describe, expect, test } from 'vitest';
import { seeded } from '../src/shared';
import {
  SpatialHash, raycast, rayCircle, separate, separateWith, clampToCircle, keepOutOfCircle, circleRect,
  launch, stepProjectiles, wasHit, ballisticAngle, type Projectile,
  cooldown, every, schedule, due, status,
  createMatch, setReady, stepMatch, endMatch, toLobby, matchTimeLeft,
  createTurns, isTurnOf, nextTurn, turnExpired, freezeTurn, resumeTurn, syncTurns, currentTurn,
  addItem, takeItem, transferItem, hasItem, itemCount,
  weighted, shuffle, int, pointInRing,
  balancedTeam, freeColor, moveTopDown, addEffect, pruneEffects, type Effect,
} from '../src/kit';

describe('spatial and collision', () => {
  test('SpatialHash finds the same neighbours as a brute-force scan', () => {
    const random = seeded(3);
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, x: random() * 100 - 50, z: random() * 100 - 50 }));
    const grid = new SpatialHash<typeof items[number]>(5).rebuild(items);
    const from = { x: 3, z: -7 };
    const brute = items.filter(item => Math.hypot(item.x - from.x, item.z - from.z) <= 9).map(i => i.id).sort();
    expect(grid.query(from, 9).map(i => i.id).sort()).toEqual(brute);
    expect(grid.nearest(from, 9)?.id).toBe(items.filter(i => brute.includes(i.id)).sort((a, b) => Math.hypot(a.x - 3, a.z + 7) - Math.hypot(b.x - 3, b.z + 7))[0].id);
  });

  test('raycast hits the closest circle along the ray', () => {
    const targets = [{ x: 0, z: 10, r: 1 }, { x: 0, z: 5, r: 1 }, { x: 5, z: 5, r: 1 }];
    const hit = raycast({ x: 0, z: 0 }, 0, 20, targets, t => t.r)!;
    expect(hit.item).toBe(targets[1]);
    expect(hit.distance).toBeCloseTo(4);
    expect(raycast({ x: 0, z: 0 }, Math.PI, 20, targets, t => t.r)).toBeUndefined();
    expect(rayCircle({ x: 0, z: 0 }, { x: 1, z: 0 }, 10, { x: 0, z: 0 }, 1)).toBe(0);
  });

  test('separation, clamps and rectangles', () => {
    const a = { x: 0, z: 0 }; const b = { x: 0.5, z: 0 };
    separate([a, b], () => 0.5, 0.5);
    expect(b.x - a.x).toBeCloseTo(1);
    const p = { x: 20, z: 0 }; clampToCircle(p, 10, 1); expect(p.x).toBeCloseTo(9);
    const q = { x: 0.1, z: 0 }; keepOutOfCircle(q, { x: 0, z: 0 }, 2); expect(q.x).toBeCloseTo(2);
    expect(circleRect({ x: -1, z: 5 }, 1.1, { x: 0, z: 0, width: 10, depth: 10 })).toBe(true);
  });

  test('separateWith relaxes a crowd like separate, from a neighbour query', () => {
    const make = () => Array.from({ length: 60 }, (_, i) => ({ id: `e${String(i).padStart(2, '0')}`, x: (i % 8) * 0.6, z: Math.floor(i / 8) * 0.6 }));
    const all = make(); const indexed = make();
    separate(all, () => 0.5);
    const grid = new SpatialHash<(typeof indexed)[number]>(2);
    grid.rebuild(indexed);
    const overlap = (items: Array<{ x: number; z: number }>) => {
      let total = 0;
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) total += Math.max(0, 1 - Math.hypot(items[i].x - items[j].x, items[i].z - items[j].z));
      return total;
    };
    const before = overlap(make());
    separateWith(indexed, () => 0.5, item => grid.query(item, 1.5));
    // Pair order differs from `separate`, so positions differ slightly; the crowd relaxes just as much.
    expect(overlap(indexed)).toBeLessThan(before * 0.75);
    expect(overlap(indexed)).toBeLessThan(overlap(all) * 1.5);
  });

  test('separate pushes apart items at exactly the same position, deterministically', () => {
    const run = () => { const items = [{ x: 1, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 1 }]; for (let i = 0; i < 20; i++) separate(items, () => 0.5); return items; };
    const items = run();
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(Math.hypot(items[i].x - items[j].x, items[i].z - items[j].z)).toBeGreaterThan(0.5);
    expect(run()).toEqual(items);
  });

  test('SpatialHash keeps far-apart cells separate', () => {
    const far = { x: 0, z: 70_000 * 4 };
    const grid = new SpatialHash<Vec>(4).rebuild([{ x: 0, z: 0 }, far, { x: -1e7, z: 3e7 }]);
    expect(grid.query({ x: 0, z: 0 }, 1)).toEqual([{ x: 0, z: 0 }]);
    expect(grid.query(far, 1)).toEqual([far]);
    expect(grid.query({ x: -1e7, z: 3e7 }, 1)).toHaveLength(1);
  });
});

type Vec = { x: number; z: number };

describe('projectiles', () => {
  test('move, hit targets, hit the ground and expire', () => {
    const projectiles: Record<string, Projectile> = {};
    const shot = launch({ id: 'p1', kind: 'bullet', owner: 'a', from: { x: 0, z: 0 }, angle: 0, speed: 40, radius: 0.1, time: 0 });
    projectiles[shot.id] = shot;
    projectiles.p2 = launch({ id: 'p2', kind: 'shell', owner: 'a', from: { x: 0, z: 0 }, angle: Math.PI / 4, speed: 10, time: 0 });
    projectiles.p3 = launch({ id: 'p3', kind: 'dud', owner: 'a', from: { x: 100, z: 100 }, angle: 0, speed: 0, time: 0, life: 0.1 });
    const target = { x: 0, z: 5 };
    const impacts: string[] = []; const expired: string[] = [];
    for (let i = 0; i < 60; i++) {
      stepProjectiles(projectiles, {
        dt: 1 / 30, time: i / 30,
        hit: p => (p.kind === 'bullet' && Math.hypot(p.x - target.x, p.z - target.z) < 0.6 ? target : undefined),
        solid: point => point.z < -1,
        accelerate: p => (p.kind === 'shell' ? { x: 0, z: -9.8 } : undefined),
        onImpact: (p, t) => { impacts.push(`${p.id}:${t ? 'target' : 'ground'}`); },
        onExpire: p => expired.push(p.id),
      });
    }
    expect(impacts).toEqual(['p1:target', 'p2:ground']);
    expect(expired).toEqual(['p3']);
    expect(Object.keys(projectiles)).toEqual([]);
  });

  test('a piercing projectile hits each target once', () => {
    const targets = [{ id: 't1', x: 0, z: 2 }, { id: 't2', x: 0, z: 4 }];
    const projectiles: Record<string, Projectile> = { p: launch({ id: 'p', kind: 'lance', owner: 'a', from: { x: 0, z: 0 }, angle: 0, speed: 10, radius: 0.1, time: 0 }) };
    const hits: string[] = [];
    for (let i = 0; i < 30; i++) {
      stepProjectiles(projectiles, {
        dt: 1 / 30, time: i / 30, substeps: 4,
        hit: p => targets.find(t => !wasHit(p, t.id) && Math.hypot(p.x - t.x, p.z - t.z) < 0.8),
        onImpact: (_p, t) => { if (t) hits.push(t.id); return true; },
      });
    }
    expect(hits).toEqual(['t1', 't2']);
    expect(JSON.parse(JSON.stringify(projectiles.p.data))).toEqual(projectiles.p.data);
    // Without the filter in `hit` the repeated target is skipped by stepProjectiles itself.
    const again: Record<string, Projectile> = { q: launch({ id: 'q', kind: 'lance', owner: 'a', from: { x: 0, z: 0 }, angle: 0, speed: 10, radius: 0.1, time: 0 }) };
    const counted: string[] = [];
    for (let i = 0; i < 30; i++) stepProjectiles(again, { dt: 1 / 30, time: i / 30, hit: p => targets.find(t => Math.hypot(p.x - t.x, p.z - t.z) < 0.8), onImpact: (_p, t) => { if (t) counted.push(t.id); return true; } });
    expect(counted).toEqual(['t1', 't2']);
  });

  test('ballisticAngle lands the shot on the target', () => {
    const angle = ballisticAngle({ x: 0, z: 0 }, { x: 30, z: 5 }, 30, 20)!;
    let x = 0; let z = 0; let vx = Math.cos(angle) * 30; let vz = Math.sin(angle) * 30;
    while (x < 30) { const dt = 0.001; vz -= 20 * dt; x += vx * dt; z += vz * dt; }
    expect(z).toBeCloseTo(5, 0);
    expect(ballisticAngle({ x: 0, z: 0 }, { x: 1000, z: 0 }, 10, 20)).toBeNull();
    expect(ballisticAngle({ x: 0, z: 0 }, { x: -30, z: 5 }, 30, 20)!).toBeCloseTo(Math.PI - angle);
  });
});

describe('timers', () => {
  test('cooldowns, every, schedule/due and statuses live in plain records', () => {
    const cooldowns: Record<string, number> = {};
    expect(cooldown.use(cooldowns, 'dash', 0, 4)).toBe(true);
    expect(cooldown.use(cooldowns, 'dash', 1, 4)).toBe(false);
    expect(cooldown.remaining(cooldowns, 'dash', 1)).toBe(3);
    const data: Record<string, number | string | boolean> = {};
    const fired = [0, 1, 2, 3, 4, 5, 6, 7].filter(t => every(data, 'tick', t, 2));
    expect(fired).toEqual([2, 4, 6]);
    schedule(data, 'boom', 0, 1.5);
    expect(due(data, 'boom', 1)).toBe(false);
    expect(due(data, 'boom', 2)).toBe(true);
    expect(due(data, 'boom', 3)).toBe(false);
    status.apply(data, 'slow', 0, 2, 0.5);
    expect(status.value(data, 'slow', 1, 1)).toBe(0.5);
    expect(status.value(data, 'slow', 3, 1)).toBe(1);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  test('every after a long gap fires once, then a full interval later', () => {
    const data: Record<string, number | string | boolean> = {};
    every(data, 'beat', 0, 2);
    expect(every(data, 'beat', 2.1, 2)).toBe(true);
    expect(data.beat).toBe(4);
    expect(every(data, 'beat', 20, 2)).toBe(true);
    expect(every(data, 'beat', 21, 2)).toBe(false);
    expect(every(data, 'beat', 22, 2)).toBe(true);
  });
});

describe('match and turns', () => {
  test('lobby → countdown → playing → ended → lobby', () => {
    const match = createMatch();
    expect(stepMatch(match, 0, ['a', 'b'], { minPlayers: 2 })).toBeUndefined();
    setReady(match, 'a'); setReady(match, 'b');
    expect(stepMatch(match, 1, ['a', 'b'], { minPlayers: 2, countdown: 3 })).toBe('countdown');
    expect(stepMatch(match, 2, ['a'], { minPlayers: 2 })).toBe('cancelled');
    setReady(match, 'a'); setReady(match, 'b');
    stepMatch(match, 2, ['a', 'b'], { minPlayers: 2, countdown: 3 });
    expect(stepMatch(match, 5, ['a', 'b'], { minPlayers: 2, duration: 60 })).toBe('start');
    expect(match).toMatchObject({ phase: 'playing', round: 1, until: 65 });
    endMatch(match, 30, 'a', 'last standing');
    expect(match).toMatchObject({ phase: 'ended', winner: 'a' });
    expect(stepMatch(match, 36, ['a', 'b'], { resultSeconds: 5 })).toBe('lobby');
    toLobby(match);
    expect(stepMatch(createMatch(), 0, ['a'], { autoStart: true, countdown: 0 })).toBe('start');
  });

  test('matchTimeLeft is 0 outside a countdown or a timed round', () => {
    const match = createMatch();
    stepMatch(match, 0, ['a'], { autoStart: true, countdown: 5 });
    expect(matchTimeLeft(match, 1)).toBe(4);
    stepMatch(match, 1, [], { autoStart: true, countdown: 5 });
    expect(match.phase).toBe('lobby');
    expect(matchTimeLeft(match, 1)).toBe(0);
    stepMatch(match, 2, ['a'], { autoStart: true, countdown: 0, duration: 60 });
    expect(matchTimeLeft(match, 12)).toBe(50);
    endMatch(match, 20, null);
    expect(matchTimeLeft(match, 21)).toBe(0);
  });

  test('turn order, skipping, freezing and syncing', () => {
    const turns = createTurns(['a', 'b', 'c'], 0, 30);
    expect(isTurnOf(turns, 'a')).toBe(true);
    expect(turnExpired(turns, 31)).toBe(true);
    expect(nextTurn(turns, 31, 30, id => id !== 'b')).toBe('c');
    freezeTurn(turns, 40);
    expect(isTurnOf(turns, 'c')).toBe(false);
    resumeTurn(turns, 50, 3);
    expect(turns.endsAt).toBe(71);
    syncTurns(turns, ['c', 'd']);
    expect(turns.order).toEqual(['c', 'd']);
    expect(currentTurn(turns)).toBe('c');
  });

  test('nextTurn with nobody able to play unfreezes the clock', () => {
    const turns = createTurns(['a', 'b'], 0, 30);
    freezeTurn(turns, 10);
    expect(nextTurn(turns, 12, 30, () => false)).toBeUndefined();
    expect(turns.frozen).toBeNull();
    expect(turns.endsAt).toBe(32);
    expect(isTurnOf(turns, 'a')).toBe(true);
  });

  test('syncTurns passes a departed current turn to the next player, wrapping around', () => {
    const last = createTurns(['a', 'b', 'c'], 0, 30, 2);
    syncTurns(last, ['a', 'b']);
    expect(currentTurn(last)).toBe('a');
    const middle = createTurns(['a', 'b', 'c', 'd'], 0, 30, 1);
    syncTurns(middle, ['a', 'd']);
    expect(currentTurn(middle)).toBe('d');
    const empty = createTurns(['a'], 0, 30);
    syncTurns(empty, []);
    expect(empty.index).toBe(0);
    syncTurns(empty, ['z']);
    expect(currentTurn(empty)).toBe('z');
  });
});

describe('inventory, random, teams, movement, effects', () => {
  test('inventory', () => {
    const bag = {}; const chest = { gold: 5 };
    expect(addItem(bag, 'arrow', 30, 20)).toBe(20);
    expect(takeItem(bag, 'arrow', 25)).toBe(false);
    expect(takeItem(bag, 'arrow', 20)).toBe(true);
    expect(bag).toEqual({});
    expect(transferItem(chest, bag, 'gold', 10)).toBe(5);
    expect(hasItem(bag, 'gold', 5)).toBe(true);
    const over = { gem: 12 };
    expect(addItem(over, 'gem', 3, 10)).toBe(0);
    expect(itemCount(over, 'gem')).toBe(12);
    expect(addItem(over, 'gem', -5)).toBe(0);
    expect(addItem(over, 'gem', Number.NaN)).toBe(0);
    expect(itemCount(over, 'gem')).toBe(12);
  });

  test('random helpers are reproducible with a seed', () => {
    const a = seeded(1); const b = seeded(1);
    expect(shuffle(a, [1, 2, 3, 4, 5])).toEqual(shuffle(b, [1, 2, 3, 4, 5]));
    expect(weighted(seeded(2), ['x', 'y'], item => (item === 'x' ? 0 : 1))).toBe('y');
    const n = int(seeded(4), 1, 6); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(6);
    const p = pointInRing(seeded(5), { x: 0, z: 0 }, 5, 6); expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(5);
  });

  test('teams, movement and effects', () => {
    expect(balancedTeam(['red', 'blue'], ['red', 'red', 'blue'])).toBe('blue');
    expect(() => balancedTeam([], [])).toThrow(/at least one team/);
    expect(freeColor(['#ff5977'])).not.toBe('#ff5977');
    const e = { x: 0, z: 0 };
    moveTopDown(e, { mx: 1, mz: 1 }, 10, 1);
    expect(Math.hypot(e.x, e.z)).toBeCloseTo(10);
    const v = { x: 0, z: 0, vx: 0, vz: 0 };
    moveTopDown(v, { mx: 1, mz: 0 }, 10, 0.1, 20);
    expect(v.vx).toBeCloseTo(2);
    let effects: Effect[] = [];
    addEffect(effects, 1, 'hit', 0, { x: 1, z: 2 }, { radius: 1 });
    addEffect(effects, 2, 'text', 1, { x: 1, z: 2 }, { text: 'hi' });
    effects = pruneEffects(effects, 1.6, 1.5);
    expect(effects.map(effect => effect.id)).toEqual([2]);
  });
});
