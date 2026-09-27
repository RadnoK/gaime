import type { BasePlayer, BaseWorld, FeedItem } from './types';

export const FEED_LIMIT = 40;

/** Engine-owned part of a new world. Spread it into your `createWorld()`. */
export function baseWorld(schema: number): Omit<BaseWorld, 'players'> & { players: Record<string, never> } {
  return { schema, version: 'LOCAL', time: 0, pause: null, hostId: null, players: {}, feed: [], seq: 0 };
}

export function nextId(world: BaseWorld): number {
  world.seq = (Number.isFinite(world.seq) ? world.seq : 0) + 1;
  return world.seq;
}

export function pushFeed(world: BaseWorld, text: string, from?: string, kind?: FeedItem['kind']): FeedItem {
  const item: FeedItem = { id: nextId(world), time: world.time, text: text.slice(0, 280), ...(from ? { from } : {}), ...(kind ? { kind } : {}) };
  world.feed.push(item);
  if (world.feed.length > FEED_LIMIT) world.feed.splice(0, world.feed.length - FEED_LIMIT);
  return item;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Fills fields missing from an older checkpoint (or HMR cache) with defaults.
 * New top-level world fields come from `createWorld()`, new player fields from a
 * template player. Existing values are never overwritten — real migrations stay explicit.
 */
export function hydrate<W extends BaseWorld>(saved: unknown, defaults: W, playerTemplate?: BasePlayer): W {
  if (!isRecord(saved)) throw new Error('The saved world is not an object.');
  const world = saved as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) if (!Object.hasOwn(world, key)) world[key] = structuredClone(value);
  if (!isRecord(world.players)) world.players = {};
  if (!Array.isArray(world.feed)) world.feed = [];
  for (const player of Object.values(world.players as Record<string, Record<string, unknown>>)) {
    if (!isRecord(player)) continue;
    if (playerTemplate) for (const [key, value] of Object.entries(playerTemplate)) {
      if (!Object.hasOwn(player, key)) player[key] = structuredClone(value);
    }
    if (!isRecord(player.data)) player.data = {};
  }
  return world as unknown as W;
}

/** Case-insensitive player lookup by id, exact name, then a unique name prefix. */
export function findPlayer<P extends BasePlayer>(players: Record<string, P>, query: string): P | undefined {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return undefined;
  if (players[query]) return players[query];
  const all = Object.values(players);
  const exact = all.find(player => player.name.toLowerCase() === wanted);
  if (exact) return exact;
  const prefix = all.filter(player => player.name.toLowerCase().startsWith(wanted));
  return prefix.length === 1 ? prefix[0] : undefined;
}
