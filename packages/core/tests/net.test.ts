import { describe, expect, test } from 'vitest';
import { applyWorldPatch, diffWorld, InputGate, projectWorld, resolveNetwork } from '../src/shared/net';

const net = resolveNetwork({ entities: ['players', 'enemies'], streams: ['feed'], hidden: ['secret'], shared: ['catalog'] });

function roundTrip(before: object, after: object) {
  const a = { world: projectWorld(before, net), revision: 1 };
  const b = { world: projectWorld(after, net), revision: 2 };
  const patch = diffWorld(a, b, net);
  const applied = applyWorldPatch(a, JSON.parse(JSON.stringify(patch)));
  return { patch, applied, expected: b.world };
}

describe('delta sync', () => {
  test('patch reproduces the next projection exactly', () => {
    const catalog = [{ id: 'x' }];
    const before = { time: 1, phase: 'lobby', catalog, players: { a: { x: 1, hp: 10, data: {} }, b: { x: 2, hp: 5, data: { k: 1 } } }, enemies: {}, feed: [{ id: 1, text: 'hi' }] };
    const after = { time: 1.5, phase: 'fight', catalog, players: { a: { x: 1.23456, hp: 10, data: {} }, c: { x: 0, hp: 1, data: {} } }, enemies: { e1: { x: 3 } }, feed: [{ id: 1, text: 'hi' }, { id: 2, text: 'yo' }], extra: true };
    const { patch, applied, expected } = roundTrip(before, after);
    expect(applied?.world).toEqual(expected);
    expect(patch.entities?.players?.remove).toEqual(['b']);
    expect(patch.entities?.players?.upsert?.a).toEqual({ x: 1.23 });
    expect(patch.streams?.feed?.add).toEqual([{ id: 2, text: 'yo' }]);
    expect(patch.values).not.toHaveProperty('catalog');
  });

  test('removed optional fields and top-level keys disappear on the client', () => {
    const { applied, expected } = roundTrip({ players: { a: { x: 1, shield: 3 } }, gone: 1 }, { players: { a: { x: 1 } } });
    expect(applied?.world).toEqual(expected);
    expect(applied?.world).not.toHaveProperty('gone');
    expect((applied?.world as { players: Record<string, object> }).players.a).not.toHaveProperty('shield');
  });

  test('hidden keys never leave the server; rounding only touches the copy', () => {
    const world = { secret: 42, players: {}, feed: [], enemies: {}, x: 1.23456 };
    const projected = projectWorld(world, net);
    expect(projected).not.toHaveProperty('secret');
    expect(projected.x).toBe(1.23);
    expect(world.x).toBe(1.23456);
  });

  test('a patch for another base is refused (client asks for a new snapshot)', () => {
    const a = { world: projectWorld({ players: {} }, net), revision: 3 };
    expect(applyWorldPatch(a, { base: 2, revision: 4 })).toBeUndefined();
    expect(applyWorldPatch(undefined, { base: 3, revision: 4 })).toBeUndefined();
  });

  test('unchanged objects are shared between snapshots', () => {
    const before = { players: { a: { x: 1 }, b: { x: 2 } }, feed: [], enemies: {} };
    const after = { players: { a: { x: 1 }, b: { x: 3 } }, feed: [], enemies: {} };
    const { applied } = roundTrip(before, after);
    const a = { world: projectWorld(before, net), revision: 1 };
    const next = applyWorldPatch(a, diffWorld(a, { world: projectWorld(after, net), revision: 2 }, net))!;
    expect((next.world as typeof before).players.a).toBe((a.world as typeof before).players.a);
    expect(applied).toBeDefined();
  });
});

describe('InputGate', () => {
  test('throttles changes and repeats unchanged input as keep-alive', () => {
    const gate = new InputGate<{ x: number }>(33, 150);
    expect(gate.next({ x: 1 }, 0)).toEqual({ x: 1 });
    expect(gate.next({ x: 1 }, 50)).toBeUndefined();
    expect(gate.next({ x: 2 }, 20 + 0)).toBeUndefined();
    expect(gate.next({ x: 2 }, 40)).toEqual({ x: 2 });
    expect(gate.next({ x: 2 }, 200)).toEqual({ x: 2 });
  });
});
