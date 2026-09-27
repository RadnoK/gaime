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

export type FeatureModule<K extends Record<string, Definition>> = {
  /** Defaults to the directory name. */
  id?: string;
  author?: string;
  description?: string;
} & { [Kind in keyof K]?: K[Kind][] };

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

/** `modules` is the result of `import.meta.glob('../features/*\/server.ts', { eager: true })`. */
export function createRegistry<K extends Record<string, Definition>>(
  modules: Record<string, { default?: FeatureModule<K> }>,
  options: RegistryOptions<K>,
): Registry<K> {
  const kinds = Object.fromEntries(options.kinds.map(kind => [kind, Object.create(null)])) as Registry<K>['kinds'];
  const lists = Object.fromEntries(options.kinds.map(kind => [kind, []])) as unknown as Registry<K>['lists'];
  const registry: Registry<K> = { kinds, lists, features: [], catalog: [], owner: {} };
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
      if (['id', 'author', 'description'].includes(key)) continue;
      if (!options.kinds.includes(key as keyof K & string)) throw new Error(`${file}: unknown kind "${key}". Available: ${options.kinds.join(', ')}.`);
    }
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
