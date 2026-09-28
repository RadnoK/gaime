/**
 * Feature registry: every `src/features/<id>/server.ts` default-exports a module
 * with arrays of definitions per kind (`enemies`, `abilities`, …). The game picks
 * the kinds; the registry validates ids and builds a serialisable catalog for clients.
 */
export interface Definition {
  id: string;
  name?: string;
  description?: string;
}

/** Any event map: event name → payload type. */
export type EventMap = Record<string, any>;
/** Modifier names → the data passed along with the value. */
export type ModifierMap = Record<string, any>;
/**
 * A module's private event, `<module>:<event>` (e.g. `ola-bomb:fuse`): needs no entry in the
 * game's shared `Events`, so modules never have to edit the game's types. Payload: any JSON.
 */
export type PrivateEvent = `${string}:${string}`;
/**
 * Events the engine itself triggers, for every game: players appearing, connecting, leaving.
 * They are part of every game's bus (`on: { 'player.joined': … }`).
 */
export type EngineEvents = {
  /** A new player (or bot) was created. */
  'player.joined': { player: string; bot: boolean };
  /** A player's connection came up (join, reconnect, bots on start). */
  'player.online': { player: string };
  /** A player's connection dropped; the character stays unless the game removes it. */
  'player.offline': { player: string };
  /** A player is being deleted from the world (kick, freed seat, `ctx.removePlayer`). */
  'player.removed': { player: string; name: string };
};

/** Payload of `Name`: from the game's map, or `any` for a module's private event. */
export type EventData<E extends EventMap, Name> = Name extends keyof E ? E[Name] : Name extends keyof EngineEvents ? EngineEvents[Name] : any;

export type SystemPhase = 'input' | 'update' | 'late';

/**
 * A piece of simulation that runs every tick (or every `every` seconds of world time).
 * Order: phase (`input` → the game's `step` → `update` → `late`), then the game's own
 * systems before feature systems, each in declaration order.
 */
export interface SystemDef<S = any> {
  /** Unique within its module; shown in `/gaime/stats`. */
  id: string;
  /** Default `update`. */
  phase?: SystemPhase;
  /**
   * Run at most every N seconds instead of every tick (AI thinking, spawners, regeneration).
   * `dt` is then the time since the last run. Systems with the same interval are
   * staggered so they do not all land on the same tick.
   */
  every?: number;
  run(sim: S, dt: number): void;
}

/** Reacts to a bus event (`ctx.trigger`). Runs after the code that triggered it, in the same tick. */
export type EventHandler<T = any, S = any> = (data: T, sim: S) => void;
/** Takes part in `ctx.modify(name, value, data)`: returns the adjusted value. */
export type Modifier<S = any> = (value: any, data: any, sim: S) => any;
/** Handles a client command of one `type` (sent with `net.command({ type, ... })`). */
export type CommandHandler<S = any> = (playerId: string, command: { type: string; [key: string]: unknown }, sim: S) => string | void;

/**
 * Engine-level behaviour any module (or the game itself) can contribute. Handlers receive the
 * game's `Sim` (from `GameDefinition.sim`), or the `GameContext` when the game defines none.
 */
export interface Behaviour<S = any, E extends EventMap = EventMap, M extends ModifierMap = ModifierMap> {
  /** Event handlers: `{ 'enemy.died': (event, sim) => … }`, plus private `'<module>:<event>'` ones. */
  on?: { [Name in keyof E]?: EventHandler<E[Name], S> } & { [Name in keyof EngineEvents]?: EventHandler<EngineEvents[Name], S> } & { [Name in PrivateEvent]?: EventHandler<any, S> };
  /** Value modifiers: `{ 'player.damage': (amount, data, sim) => amount * 0.8 }`. */
  modify?: { [Name in keyof M]?: (value: any, data: M[Name], sim: S) => any };
  systems?: SystemDef<S>[];
  /** Client commands this module adds, by `type`. Types are global: prefix them with the module id. */
  commands?: Record<string, CommandHandler<S>>;
}

/** Keys of a feature module that are not definition kinds. */
export const RESERVED_KEYS = ['id', 'author', 'description', 'on', 'modify', 'systems', 'commands'] as const;

export type FeatureModule<K extends Record<string, Definition>, S = any, E extends EventMap = EventMap, M extends ModifierMap = ModifierMap> = {
  /** Defaults to the directory name. */
  id?: string;
  author?: string;
  description?: string;
} & Behaviour<S, E, M> & { [Kind in keyof K]?: K[Kind][] };

/** A behaviour contributed by one owner (`game` or a feature id). */
export interface Owned<T> { owner: string; value: T }

export interface CatalogEntry {
  kind: string;
  id: string;
  feature: string;
  author: string;
  name: string;
  description: string;
  /** JSON-safe copy of the remaining definition fields (functions stripped). */
  [field: string]: unknown;
}

export interface Registry<K extends Record<string, Definition>> {
  kinds: { [Kind in keyof K]: Record<string, K[Kind]> };
  /** Lists per kind in stable (file path) order. */
  lists: { [Kind in keyof K]: K[Kind][] };
  features: Array<{ id: string; author: string; description: string; file: string }>;
  catalog: CatalogEntry[];
  /** Feature id owning each definition, keyed `${kind}/${id}`. */
  owner: Record<string, string>;
  /** Behaviour of every module, in module order (wired by the engine via `GameDefinition.features`). */
  handlers: Array<Owned<{ event: string; run: EventHandler }>>;
  modifiers: Array<Owned<{ name: string; run: Modifier }>>;
  systems: Array<Owned<SystemDef>>;
  commands: Record<string, Owned<CommandHandler>>;
}

export interface RegistryOptions<K extends Record<string, Definition>> {
  kinds: Array<keyof K & string>;
  /** Extra validation per kind; throw with a clear message to reject the module. */
  validate?: { [Kind in keyof K]?: (definition: K[Kind], feature: string) => void };
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'function' || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(jsonSafe).filter(item => item !== undefined);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) { const safe = jsonSafe(item); if (safe !== undefined) out[key] = safe; }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
  return value;
}

/** Validates and appends the `on` / `modify` / `systems` / `commands` of one owner. */
export function collectBehaviour(target: Pick<Registry<any>, 'handlers' | 'modifiers' | 'systems' | 'commands'>, behaviour: Behaviour<any, any, any>, owner: string, where = owner) {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (behaviour.on !== undefined) {
    if (!isRecord(behaviour.on)) throw new Error(`${where}: "on" must be an object of event handlers.`);
    for (const [event, run] of Object.entries(behaviour.on)) {
      if (typeof run !== 'function') throw new Error(`${where}: on["${event}"] must be a function.`);
      target.handlers.push({ owner, value: { event, run: run as EventHandler } });
    }
  }
  if (behaviour.modify !== undefined) {
    if (!isRecord(behaviour.modify)) throw new Error(`${where}: "modify" must be an object of modifiers.`);
    for (const [name, run] of Object.entries(behaviour.modify)) {
      if (typeof run !== 'function') throw new Error(`${where}: modify["${name}"] must be a function.`);
      target.modifiers.push({ owner, value: { name, run: run as Modifier } });
    }
  }
  if (behaviour.systems !== undefined) {
    if (!Array.isArray(behaviour.systems)) throw new Error(`${where}: "systems" must be an array.`);
    const seen = new Set<string>();
    for (const system of behaviour.systems) {
      if (!system || typeof system.id !== 'string' || !ID.test(system.id)) throw new Error(`${where}: a system has an invalid id "${system?.id}".`);
      if (seen.has(system.id)) throw new Error(`${where}: duplicate system id "${system.id}".`);
      if (typeof system.run !== 'function') throw new Error(`${where}: system "${system.id}" needs a run(sim, dt) function.`);
      if (system.phase !== undefined && !['input', 'update', 'late'].includes(system.phase)) throw new Error(`${where}: system "${system.id}" has an unknown phase "${system.phase}".`);
      if (system.every !== undefined && !(system.every > 0)) throw new Error(`${where}: system "${system.id}": every must be a positive number of seconds.`);
      seen.add(system.id);
      target.systems.push({ owner, value: system });
    }
  }
  if (behaviour.commands !== undefined) {
    if (!isRecord(behaviour.commands)) throw new Error(`${where}: "commands" must be an object of command handlers.`);
    for (const [type, run] of Object.entries(behaviour.commands)) {
      if (typeof run !== 'function') throw new Error(`${where}: commands["${type}"] must be a function.`);
      if (type.startsWith('$')) throw new Error(`${where}: command types starting with "$" belong to the engine.`);
      if (target.commands[type]) throw new Error(`${where}: command "${type}" is already handled by ${target.commands[type].owner}.`);
      target.commands[type] = { owner, value: run as CommandHandler };
    }
  }
}

/** `modules` is the result of `import.meta.glob('../features/*\/server.ts', { eager: true })`. */
export function createRegistry<K extends Record<string, Definition>>(
  modules: Record<string, { default?: FeatureModule<K> }>,
  options: RegistryOptions<K>,
): Registry<K> {
  const kinds = Object.fromEntries(options.kinds.map(kind => [kind, Object.create(null)])) as Registry<K>['kinds'];
  const lists = Object.fromEntries(options.kinds.map(kind => [kind, []])) as unknown as Registry<K>['lists'];
  for (const kind of options.kinds) if ((RESERVED_KEYS as readonly string[]).includes(kind)) throw new Error(`"${kind}" cannot be a kind name: it is reserved for module behaviour.`);
  const registry: Registry<K> = { kinds, lists, features: [], catalog: [], owner: {}, handlers: [], modifiers: [], systems: [], commands: {} };
  const featureIds = new Set<string>();
  for (const file of Object.keys(modules).sort()) {
    const feature = modules[file]?.default;
    const folder = file.split('/').at(-2) ?? file;
    if (!feature || typeof feature !== 'object') throw new Error(`${file}: missing default export (export default { ... } satisfies Feature).`);
    const id = feature.id ?? folder;
    if (!ID.test(id)) throw new Error(`${file}: invalid feature id "${id}" (lowercase letters, digits, dashes).`);
    if (featureIds.has(id)) throw new Error(`${file}: duplicate feature id "${id}".`);
    featureIds.add(id);
    const author = typeof feature.author === 'string' && feature.author.trim() ? feature.author.trim() : 'anonymous';
    registry.features.push({ id, author, description: feature.description ?? '', file });
    for (const key of Object.keys(feature)) {
      if ((RESERVED_KEYS as readonly string[]).includes(key)) continue;
      if (!options.kinds.includes(key as keyof K & string)) throw new Error(`${file}: unknown kind "${key}". Available: ${options.kinds.join(', ')}.`);
    }
    collectBehaviour(registry, feature, id, file);
    for (const kind of options.kinds) {
      const definitions = feature[kind];
      if (definitions === undefined) continue;
      if (!Array.isArray(definitions)) throw new Error(`${file}: "${kind}" must be an array.`);
      for (const definition of definitions as K[typeof kind][]) {
        if (!definition || typeof definition.id !== 'string' || !ID.test(definition.id)) throw new Error(`${file}: ${kind} has an invalid id "${definition?.id}".`);
        if (kinds[kind][definition.id]) throw new Error(`${file}: duplicate id ${kind}/${definition.id} (already defined in feature ${registry.owner[`${kind}/${definition.id}`]}).`);
        options.validate?.[kind]?.(definition, id);
        (kinds[kind] as Record<string, Definition>)[definition.id] = definition;
        (lists[kind] as Definition[]).push(definition);
        registry.owner[`${kind}/${definition.id}`] = id;
        registry.catalog.push({
          ...(jsonSafe(definition) as Record<string, unknown>),
          kind, id: definition.id, feature: id, author,
          name: definition.name ?? definition.id,
          description: definition.description ?? '',
        });
      }
    }
  }
  return registry;
}
