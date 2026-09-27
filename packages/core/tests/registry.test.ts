import { describe, expect, test } from 'vitest';
import { createRegistry, hydrate, baseWorld } from '../src/shared';

type Kinds = { items: { id: string; name: string; description: string; power: number; use?: () => void } };

describe('createRegistry', () => {
  test('collects definitions from every module and builds a JSON-safe catalog', () => {
    const registry = createRegistry<Kinds>({
      '../features/b/server.ts': { default: { author: 'Ola', items: [{ id: 'bomb', name: 'Bomb', description: 'Boom', power: 3, use() {} }] } },
      '../features/a/server.ts': { default: { items: [{ id: 'axe', name: 'Axe', description: '', power: 1 }] } },
    }, { kinds: ['items'] });
    expect(registry.lists.items.map(item => item.id)).toEqual(['axe', 'bomb']);
    expect(registry.kinds.items.bomb.power).toBe(3);
    expect(registry.features.map(f => [f.id, f.author])).toEqual([['a', 'anonymous'], ['b', 'Ola']]);
    const bomb = registry.catalog.find(entry => entry.id === 'bomb')!;
    expect(bomb).toMatchObject({ kind: 'items', feature: 'b', author: 'Ola', power: 3 });
    expect(bomb).not.toHaveProperty('use');
    expect(JSON.parse(JSON.stringify(registry.catalog))).toEqual(registry.catalog);
  });

  test('rejects duplicate ids, unknown kinds and failed validation with the file name', () => {
    const item = { id: 'axe', name: 'x', description: '', power: 1 };
    expect(() => createRegistry<Kinds>({ 'f/a/server.ts': { default: { items: [item] } }, 'f/b/server.ts': { default: { items: [item] } } }, { kinds: ['items'] })).toThrow(/duplicate id items\/axe/);
    expect(() => createRegistry<Kinds>({ 'f/a/server.ts': { default: { weapons: [] } as never } }, { kinds: ['items'] })).toThrow(/unknown kind "weapons"/);
    expect(() => createRegistry<Kinds>({ 'f/a/server.ts': { default: { items: [{ ...item, power: -1 }] } } }, {
      kinds: ['items'], validate: { items: def => { if (def.power < 0) throw new Error(`${def.id}: power < 0`); } },
    })).toThrow(/power < 0/);
    expect(() => createRegistry<Kinds>({ 'f/a/server.ts': { default: { items: [{ ...item, id: 'Bad Id' }] } } }, { kinds: ['items'] })).toThrow(/invalid id/);
  });
});

describe('hydrate', () => {
  test('fills fields added after the save was written, never overwrites existing ones', () => {
    const defaults = { ...baseWorld(2), score: 0, bosses: {} as Record<string, unknown> };
    const saved = { schema: 1, version: 'old', time: 12, pause: null, hostId: null, feed: [], seq: 5, players: { p: { id: 'p', name: 'A', online: false, hp: 50 } }, score: 7 };
    const world = hydrate(saved, defaults as never, { id: 't', name: 't', online: true, data: {}, hp: 100, mana: 30 } as never) as unknown as typeof defaults & { players: Record<string, Record<string, unknown>> };
    expect(world.score).toBe(7);
    expect(world.bosses).toEqual({});
    expect(world.players.p).toMatchObject({ hp: 50, mana: 30, data: {} });
    expect(world.schema).toBe(1);
  });
});
