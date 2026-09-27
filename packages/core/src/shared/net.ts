/**
 * Delta synchronisation of a plain-JSON world.
 *
 * The server keeps the authoritative world untouched. For every publish it takes a
 * detached, rounded projection (`projectWorld`) and sends each client a patch against
 * the projection that client last acknowledged by receiving it (`diffWorld`).
 * Clients rebuild the next projection with `applyWorldPatch`; unchanged objects are
 * shared between snapshots, so never mutate a received world on the client.
 *
 * Anything that is not listed in `entities`/`streams` is still synchronised, just as a
 * whole value whenever it changes — new world fields work without configuration.
 */
export interface NetworkConfig {
  /** Top-level `Record<id, object>` dictionaries diffed per entity and per field. Default: `['players']`. */
  entities?: string[];
  /** Top-level arrays of immutable `{ id }` objects, sent as add/remove. Default: `['feed']`. */
  streams?: string[];
  /** Field name → rounding factor applied to the network copy only (100 → 0.01). */
  precision?: Record<string, number>;
  /** Top-level keys that never leave the server. */
  hidden?: string[];
  /** Top-level keys that are replaced wholesale, never mutated: shared by reference. */
  shared?: string[];
}

export const DEFAULT_PRECISION: Record<string, number> = {
  x: 100, y: 100, z: 100, vx: 100, vy: 100, vz: 100, angle: 100, aim: 100, yaw: 100, time: 1000,
};

type Dict = Record<string, Record<string, unknown>>;
type StreamItem = { id: string | number };

export interface WorldPatch {
  base: number;
  revision: number;
  values?: Record<string, unknown>;
  /** Top-level keys that disappeared. */
  removed?: string[];
  entities?: Record<string, { upsert?: Dict; remove?: string[] }>;
  streams?: Record<string, { add: StreamItem[]; remove: Array<string | number> }>;
}

export interface WorldSnapshot<W = unknown> {
  world: W;
  revision: number;
}

export interface ResolvedNetwork {
  entities: Set<string>;
  streams: Set<string>;
  precision: Record<string, number>;
  hidden: Set<string>;
  shared: Set<string>;
}

export function resolveNetwork(config: NetworkConfig = {}): ResolvedNetwork {
  return {
    entities: new Set(config.entities ?? ['players']),
    streams: new Set(config.streams ?? ['feed']),
    precision: { ...DEFAULT_PRECISION, ...config.precision },
    hidden: new Set(config.hidden ?? []),
    shared: new Set(config.shared ?? []),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Detached, rounded copy for the network. The authoritative world is never rounded or mutated. */
export function projectWorld<W extends object>(world: W, net: ResolvedNetwork): W {
  const copy = (value: unknown, key: string): unknown => {
    if (typeof value === 'number') {
      const factor = net.precision[key];
      return factor && Number.isFinite(value) ? Math.round(value * factor) / factor : value;
    }
    if (Array.isArray(value)) return value.map(item => copy(item, ''));
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) if (v !== undefined && typeof v !== 'function') out[k] = copy(v, k);
      return out;
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(world)) {
    if (net.hidden.has(key) || value === undefined) continue;
    out[key] = net.shared.has(key) ? value : copy(value, key);
  }
  return out as W;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffWorld<W extends object>(previous: WorldSnapshot<W>, current: WorldSnapshot<W>, net: ResolvedNetwork): WorldPatch {
  const before = previous.world as Record<string, unknown>;
  const after = current.world as Record<string, unknown>;
  const patch: WorldPatch = { base: previous.revision, revision: current.revision };
  const values: Record<string, unknown> = {};
  const entities: NonNullable<WorldPatch['entities']> = {};
  const streams: NonNullable<WorldPatch['streams']> = {};

  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (net.shared.has(key)) { if (a !== b) values[key] = b; continue; }
    if (net.entities.has(key) && isRecord(a) && isRecord(b)) {
      const change = diffDictionary(a as Dict, b as Dict);
      if (change) entities[key] = change;
      continue;
    }
    if (net.streams.has(key) && Array.isArray(a) && Array.isArray(b)) {
      const change = diffStream(a as StreamItem[], b as StreamItem[]);
      if (change) streams[key] = change;
      continue;
    }
    if (!equal(a, b)) values[key] = b;
  }
  const removed = Object.keys(before).filter(key => !Object.hasOwn(after, key));
  if (Object.keys(values).length) patch.values = values;
  if (removed.length) patch.removed = removed;
  if (Object.keys(entities).length) patch.entities = entities;
  if (Object.keys(streams).length) patch.streams = streams;
  return patch;
}

function diffDictionary(before: Dict, after: Dict) {
  const upsert: Dict = {};
  const remove = Object.keys(before).filter(id => !Object.hasOwn(after, id));
  for (const [id, entity] of Object.entries(after)) {
    const old = before[id];
    if (!isRecord(old) || !isRecord(entity)) { if (!equal(old, entity)) { if (old !== undefined) remove.push(id); upsert[id] = entity; } continue; }
    // An optional field disappeared: replace the whole entity so a shallow merge
    // on the client cannot keep the stale field alive.
    if (Object.keys(old).some(field => !Object.hasOwn(entity, field))) { remove.push(id); upsert[id] = entity; continue; }
    const changed: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(entity)) if (!equal(old[field], value)) changed[field] = value;
    if (Object.keys(changed).length) upsert[id] = changed;
  }
  if (!remove.length && !Object.keys(upsert).length) return undefined;
  return { ...(remove.length ? { remove } : {}), ...(Object.keys(upsert).length ? { upsert } : {}) };
}

function diffStream(before: StreamItem[], after: StreamItem[]) {
  const old = new Map(before.map(item => [item.id, item]));
  const next = new Set(after.map(item => item.id));
  const add = after.filter(item => !equal(old.get(item.id), item));
  const remove = before.filter(item => !next.has(item.id) || add.some(added => added.id === item.id)).map(item => item.id);
  return add.length || remove.length ? { add, remove } : undefined;
}

/** Returns undefined for a patch that does not fit the snapshot: request a new baseline. */
export function applyWorldPatch<W extends object>(previous: WorldSnapshot<W> | undefined, patch: WorldPatch): WorldSnapshot<W> | undefined {
  if (!previous || patch.base !== previous.revision || patch.revision <= patch.base) return undefined;
  const world: Record<string, unknown> = { ...(previous.world as Record<string, unknown>), ...patch.values };
  for (const key of patch.removed ?? []) delete world[key];
  for (const [key, change] of Object.entries(patch.entities ?? {})) {
    const dictionary: Dict = { ...(world[key] as Dict) };
    for (const id of change.remove ?? []) delete dictionary[id];
    for (const [id, fields] of Object.entries(change.upsert ?? {})) {
      dictionary[id] = isRecord(fields) && isRecord(dictionary[id]) ? { ...dictionary[id], ...fields } : fields;
    }
    world[key] = dictionary;
  }
  for (const [key, change] of Object.entries(patch.streams ?? {})) {
    const removed = new Set(change.remove);
    world[key] = [...(world[key] as StreamItem[]).filter(item => !removed.has(item.id)), ...change.add];
  }
  return { world: world as W, revision: patch.revision };
}

/**
 * Client-side input throttle: changed input goes out at most every `minMs`,
 * unchanged input is repeated every `keepAliveMs` so the server lease never expires.
 */
export class InputGate<I> {
  private previous?: string;
  private sentAt = -Infinity;
  constructor(private readonly minMs = 33, private readonly keepAliveMs = 150) {}
  reset() { this.previous = undefined; this.sentAt = -Infinity; }
  next(input: I, now: number): I | undefined {
    const encoded = JSON.stringify(input);
    const elapsed = now - this.sentAt;
    const changed = encoded !== this.previous;
    if (this.previous !== undefined && (changed ? elapsed < this.minMs : elapsed < this.keepAliveMs)) return undefined;
    this.previous = encoded; this.sentAt = now;
    return input;
  }
}
