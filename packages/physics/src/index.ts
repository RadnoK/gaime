import RAPIER from '@dimforge/rapier2d-compat';
import type { SystemDef, SystemPhase } from '@gaime/core';

// The WebAssembly module is inlined (base64): no files to serve, works in Vite SSR, builds and tests.
await RAPIER.init();

/**
 * Rigid-body physics for gaime games (Rapier 2D).
 *
 * The world stays plain JSON: bodies are entities of top-level `Record<id, entity>` collections
 * carrying `x, z, vx, vz, angle, spin`. The Rapier world is a derived resource (`ctx.resource`)
 * — kept across ticks, rebuilt from the JSON after a hot reload or restart. Game code moves things
 * by writing those fields; the physics step picks the changes up and writes the results back.
 */

/** A point or vector on the world plane (x, z). Rapier's y is the world's z. */
export interface Vec { x: number; z: number }

/** Fields an entity of a body collection carries (missing ones are added with 0). */
export interface Body {
  x: number;
  z: number;
  /** Linear velocity (units/s). */
  vx: number;
  vz: number;
  /** Rotation in radians, counter-clockwise from +x towards +z. */
  angle: number;
  /** Angular velocity (rad/s). */
  spin: number;
}

/** Collider shapes: a circle (radius), a box (full width along x, depth along z), a convex polygon (local points). */
export type Shape = { circle: number } | { box: [number, number] } | { polygon: Array<[number, number]> };

/** A number, or one derived from the entity (re-read every step; changes are applied). */
export type Value<T> = number | ((entity: T) => number);

export interface BodyOptions<T> {
  /** `dynamic` (default): simulated. `kinematic`: moved by the game (x/z), pushes dynamic bodies. `fixed`: a wall. */
  type?: 'dynamic' | 'kinematic' | 'fixed';
  /** A shape, or one derived from the entity (re-read every step; a change rebuilds the collider). */
  shape: Shape | ((entity: T) => Shape);
  /** Mass per unit area. Default 1. */
  density?: Value<T>;
  /** Default 0.5. */
  friction?: Value<T>;
  /** Bounciness 0..1. Default 0. */
  restitution?: Value<T>;
  /** Velocity lost per second (air/floor drag). Default 0. */
  linearDamping?: Value<T>;
  angularDamping?: Value<T>;
  /** Multiplies the world's gravity. Default 1. */
  gravityScale?: Value<T>;
  /** Never rotate (characters). */
  lockRotation?: boolean;
  /** Continuous collision detection for fast, small bodies (bullets). */
  ccd?: boolean;
  /** Detects overlaps (contact events) without pushing anything. */
  sensor?: boolean;
  /** Which entities get a body (default: all). Re-checked every step: `false` removes the body. */
  include?: (entity: T) => boolean;
}

/** A static collider that is not an entity (arena walls, zones). Rebuilt when the list's JSON changes. */
export interface StaticCollider {
  /** Stable name; contact events report it as `{ collection: 'static', id: key }`. */
  key: string;
  shape: Shape;
  x?: number;
  z?: number;
  angle?: number;
  sensor?: boolean;
  friction?: number;
  restitution?: number;
}

type EntityOf<C> = C extends Record<string, infer T> ? T : never;

export interface PhysicsConfig<W> {
  /** Resource key; change it only to run two independent physics worlds. Default `gaime-physics`. */
  key?: string;
  /** Acceleration on the world plane. Top-down games: none. Side views (z up): `{ x: 0, z: -20 }`. */
  gravity?: Vec;
  /** Body collections: top-level `Record<id, entity>` keys of the world. Bodies are created in this order. */
  bodies: { [K in keyof W]?: BodyOptions<EntityOf<W[K]>> };
  /** Static colliders derived from the world (arena, walls); rebuilt when the returned JSON changes. */
  statics?: (world: W) => StaticCollider[];
  /** Trigger `physics.contact` on the bus when two colliders start or stop touching. Default false. */
  contacts?: boolean;
  /** Rapier steps per engine tick (more = stiffer, more accurate collisions). Default 1. */
  substeps?: number;
}

/** One side of a contact: an entity, or a static collider (`collection: 'static'`, `id`: its key). */
export interface BodyRef { collection: string; id: string }

/** Payload of the `physics.contact` event — add `'physics.contact': PhysicsContact` to the game's `Events`. */
export interface PhysicsContact {
  a: BodyRef;
  b: BodyRef;
  /** true when the contact began, false when it ended. */
  started: boolean;
  /** One of the two is a sensor (an overlap, not a collision). */
  sensor: boolean;
  /** Relative speed of the two bodies right after the step (a rough impact strength). */
  speed: number;
}

export interface RayHit extends BodyRef {
  point: Vec;
  /** Surface normal at the hit point. */
  normal: Vec;
  distance: number;
}

/**
 * What the physics needs from the engine: the game's `GameContext` fits, and so does a game's
 * `Sim` that exposes `world`, `resource` and `trigger`.
 */
export interface PhysicsContext {
  readonly world: object;
  resource<T>(key: string, create: () => T, options?: ((value: T) => void) | { dispose?(value: T): void; save?(value: T): unknown; load?(data: unknown): T }): T;
  trigger(event: string, data?: unknown): void;
}

/** The subset the plain JSON helpers need. */
export interface WorldContext { readonly world: object }

export const CONTACT_EVENT = 'physics.contact';
export const STATIC = 'static';

type Entity = Record<string, unknown> & Body;
type Tracked = {
  id: string;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  shape: string;
  /** Last values the physics wrote (or read): a difference in the JSON is an external change. */
  x: number; z: number; vx: number; vz: number; angle: number; spin: number;
  /** Last applied values of function-valued properties. */
  props: Record<string, number>;
};
type Collection = { name: string; options: BodyOptions<any>; tracked: Map<string, Tracked> };
type State = {
  world: object;
  rapier: RAPIER.World;
  events?: RAPIER.EventQueue;
  collections: Collection[];
  refs: Map<number, { ref: BodyRef; sensor: boolean; body?: RAPIER.RigidBody }>;
  statics: { json: string; colliders: RAPIER.Collider[] };
};
type Holder = { state?: State; restored?: boolean };

/** What a flight recording keeps of the Rapier world (see `ResourceOptions.save`). */
type Saved = {
  snapshot: string;
  collections: Array<[name: string, tracked: Array<[id: string, body: number, collider: number, shape: string, values: number[], props: Record<string, number>]>]>;
  statics: { json: string; colliders: number[]; keys: string[]; sensors: boolean[] };
};

const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

const COLLIDER_PROPS = ['density', 'friction', 'restitution'] as const;
const BODY_PROPS = ['linearDamping', 'angularDamping', 'gravityScale'] as const;
const DEFAULTS: Record<string, number> = { density: 1, friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0, gravityScale: 1 };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const shapeKey = (shape: Shape) => JSON.stringify(shape);

function shapeDesc(shape: Shape): RAPIER.ColliderDesc {
  if ('circle' in shape) {
    if (!(shape.circle > 0)) throw new Error(`physics: circle radius must be positive (got ${shape.circle}).`);
    return RAPIER.ColliderDesc.ball(shape.circle);
  }
  if ('box' in shape) {
    const [w, d] = shape.box;
    if (!(w > 0 && d > 0)) throw new Error(`physics: box size must be positive (got ${w} × ${d}).`);
    return RAPIER.ColliderDesc.cuboid(w / 2, d / 2);
  }
  if ('polygon' in shape) {
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(shape.polygon.flat()));
    if (!desc) throw new Error('physics: polygon needs at least 3 points that are not on one line.');
    return desc;
  }
  throw new Error(`physics: unknown shape ${JSON.stringify(shape)} (circle, box or polygon).`);
}

function area(shape: Shape): number {
  if ('circle' in shape) return Math.PI * shape.circle ** 2;
  if ('box' in shape) return shape.box[0] * shape.box[1];
  let sum = 0;
  const points = shape.polygon;
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i]; const [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}

const valueOf = <T>(value: Value<T> | undefined, entity: T, fallback: number) => {
  const result = typeof value === 'function' ? value(entity) : value;
  return finite(result) ? result : fallback;
};

export interface Physics<W> {
  /**
   * The engine system that steps the physics every tick: `defineGame({ systems: [physics.system()] })`.
   * Its `sim` must satisfy `PhysicsContext`; otherwise pass `context: sim => …`.
   */
  system<S extends PhysicsContext = PhysicsContext>(options?: { id?: string; phase?: SystemPhase }): SystemDef<S>;
  system<S>(options: { id?: string; phase?: SystemPhase; context: (sim: S) => PhysicsContext }): SystemDef<S>;
  /** One physics step of `dt` seconds (what the system does): sync JSON → Rapier, step, write back, contacts. */
  step(ctx: PhysicsContext, dt: number): void;
  /** Add `impulse` (mass × Δv) to an entity's velocity. Returns false for unknown or non-dynamic entities. */
  impulse(ctx: WorldContext & Partial<PhysicsContext>, collection: keyof W & string, id: string, impulse: Vec): boolean;
  /** Set an entity's velocity (the same as writing `vx`/`vz`). */
  setVelocity(ctx: WorldContext, collection: keyof W & string, id: string, velocity: Vec): boolean;
  /** Move an entity (the same as writing `x`/`z`); stops it unless `keepVelocity`. */
  teleport(ctx: WorldContext, collection: keyof W & string, id: string, at: Vec, options?: { keepVelocity?: boolean; angle?: number }): boolean;
  /** Mass of an entity's body (from Rapier when it exists, else from shape × density). */
  mass(ctx: WorldContext & Partial<PhysicsContext>, collection: keyof W & string, id: string): number;
  /**
   * The first collider along a ray, as of the last physics step. `direction` need not be normalised;
   * sensors are skipped unless `sensors: true`.
   */
  raycast(ctx: PhysicsContext, from: Vec, direction: Vec, maxDistance: number, options?: { exclude?: BodyRef; sensors?: boolean; filter?: (hit: BodyRef) => boolean }): RayHit | undefined;
  /** Drop the Rapier world; the next step rebuilds it from the JSON (what a hot reload does). */
  reset(ctx: PhysicsContext): void;
  /** Bodies currently in the Rapier world (diagnostics). */
  count(ctx: PhysicsContext): number;
}

/** Create the physics of a game. Keep the returned object in a server module (never import it from the client). */
export function createPhysics<W extends object>(config: PhysicsConfig<W>): Physics<W> {
  const key = config.key ?? 'gaime-physics';
  const substeps = Math.max(1, Math.floor(config.substeps ?? 1));
  const collections = Object.entries(config.bodies as Record<string, BodyOptions<any> | undefined>).filter((entry): entry is [string, BodyOptions<any>] => !!entry[1]);
  for (const [name, options] of collections) {
    if (name === STATIC) throw new Error(`physics: "${STATIC}" is reserved for static colliders.`);
    if (!options.shape) throw new Error(`physics: bodies.${name} needs a shape.`);
  }

  const free = (state: State | undefined) => { state?.events?.free(); state?.rapier.free(); };
  const holder = (ctx: PhysicsContext) => ctx.resource<Holder>(key, () => ({}), {
    dispose: h => { free(h.state); h.state = undefined; },
    // A flight recording keeps Rapier's complete state (contacts, warm starting, sleeping bodies),
    // so a replay that starts mid-game continues bit for bit.
    save: h => h.state ? save(h.state) : undefined,
    load: data => ({ state: load(data as Saved), restored: true }),
  });

  function save(s: State): Saved {
    return {
      snapshot: toBase64(s.rapier.takeSnapshot()),
      collections: s.collections.map(c => [c.name, [...c.tracked.values()].map(t => [t.id, t.body.handle, t.collider.handle, t.shape, [t.x, t.z, t.vx, t.vz, t.angle, t.spin], { ...t.props }])]),
      statics: {
        json: s.statics.json,
        colliders: s.statics.colliders.map(c => c.handle),
        keys: s.statics.colliders.map(c => s.refs.get(c.handle)?.ref.id ?? ''),
        sensors: s.statics.colliders.map(c => !!s.refs.get(c.handle)?.sensor),
      },
    };
  }

  function load(data: Saved): State {
    const rapier = RAPIER.World.restoreSnapshot(fromBase64(data.snapshot));
    const s: State = {
      world: {}, rapier,
      events: config.contacts ? new RAPIER.EventQueue(true) : undefined,
      collections: collections.map(([name, options]) => ({ name, options, tracked: new Map() })),
      refs: new Map(),
      statics: { json: '', colliders: [] },
    };
    for (const [name, list] of data.collections) {
      const collection = s.collections.find(c => c.name === name);
      if (!collection) continue;
      for (const [id, bodyHandle, colliderHandle, shape, [x, z, vx, vz, angle, spin], props] of list) {
        const body = rapier.getRigidBody(bodyHandle); const collider = rapier.getCollider(colliderHandle);
        if (!body || !collider) continue;
        collection.tracked.set(id, { id, body, collider, shape, x, z, vx, vz, angle, spin, props });
        s.refs.set(colliderHandle, { ref: { collection: name, id }, sensor: !!collection.options.sensor, body });
      }
    }
    s.statics = { json: data.statics.json, colliders: data.statics.colliders.map(handle => rapier.getCollider(handle)).filter(Boolean) };
    data.statics.colliders.forEach((handle, i) => s.refs.set(handle, { ref: { collection: STATIC, id: data.statics.keys[i] }, sensor: data.statics.sensors[i] }));
    return s;
  }

  function build(world: object): State {
    const gravity = config.gravity ?? { x: 0, z: 0 };
    return {
      world,
      rapier: new RAPIER.World({ x: gravity.x, y: gravity.z }),
      events: config.contacts ? new RAPIER.EventQueue(true) : undefined,
      collections: collections.map(([name, options]) => ({ name, options, tracked: new Map() })),
      refs: new Map(),
      statics: { json: '', colliders: [] },
    };
  }

  function state(ctx: PhysicsContext): State {
    const h = holder(ctx);
    // Loaded from a recording: it belongs to the world being replayed.
    if (h.restored && h.state) { h.state.world = ctx.world; h.restored = false; }
    // A different world object (a restored save, a new room) is a fresh start too.
    if (!h.state || h.state.world !== ctx.world) { free(h.state); h.state = build(ctx.world); }
    return h.state;
  }

  function attach(s: State, collection: Collection, tracked: Tracked, entity: Entity, shape: Shape) {
    const { options } = collection;
    const desc = shapeDesc(shape)
      .setDensity(valueOf(options.density, entity, DEFAULTS.density))
      .setFriction(valueOf(options.friction, entity, DEFAULTS.friction))
      .setRestitution(valueOf(options.restitution, entity, DEFAULTS.restitution))
      .setSensor(!!options.sensor);
    if (config.contacts) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    tracked.collider = s.rapier.createCollider(desc, tracked.body);
    tracked.shape = shapeKey(shape);
    s.refs.set(tracked.collider.handle, { ref: { collection: collection.name, id: tracked.id }, sensor: !!options.sensor, body: tracked.body });
  }

  function create(s: State, collection: Collection, id: string, entity: Entity) {
    const { options } = collection;
    for (const field of ['x', 'z', 'vx', 'vz', 'angle', 'spin'] as const) if (!finite(entity[field])) entity[field] = 0;
    const type = options.type ?? 'dynamic';
    const desc = type === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : type === 'kinematic' ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(entity.x, entity.z).setRotation(entity.angle)
      .setLinearDamping(valueOf(options.linearDamping, entity, DEFAULTS.linearDamping))
      .setAngularDamping(valueOf(options.angularDamping, entity, DEFAULTS.angularDamping))
      .setGravityScale(valueOf(options.gravityScale, entity, DEFAULTS.gravityScale))
      .setCcdEnabled(!!options.ccd);
    if (type === 'dynamic') desc.setLinvel(entity.vx, entity.vz).setAngvel(entity.spin);
    if (options.lockRotation) desc.lockRotations();
    const body = s.rapier.createRigidBody(desc);
    const tracked: Tracked = { id, body, collider: undefined!, shape: '', x: entity.x, z: entity.z, vx: entity.vx, vz: entity.vz, angle: entity.angle, spin: entity.spin, props: {} };
    const shape = typeof options.shape === 'function' ? options.shape(entity) : options.shape;
    attach(s, collection, tracked, entity, shape);
    for (const prop of [...COLLIDER_PROPS, ...BODY_PROPS]) if (typeof options[prop] === 'function') tracked.props[prop] = valueOf(options[prop], entity, DEFAULTS[prop]);
    collection.tracked.set(id, tracked);
  }

  function remove(s: State, collection: Collection, tracked: Tracked) {
    s.refs.delete(tracked.collider.handle);
    s.rapier.removeRigidBody(tracked.body);
    collection.tracked.delete(tracked.id);
  }

  /** Apply what game code changed in the JSON since the last step. */
  function update(s: State, collection: Collection, tracked: Tracked, entity: Entity) {
    const { options } = collection;
    const { body } = tracked;
    const kinematic = options.type === 'kinematic';
    if (entity.x !== tracked.x || entity.z !== tracked.z) {
      if (finite(entity.x) && finite(entity.z)) {
        if (kinematic) body.setNextKinematicTranslation({ x: entity.x, y: entity.z });
        else body.setTranslation({ x: entity.x, y: entity.z }, true);
      } else { entity.x = tracked.x; entity.z = tracked.z; }
    }
    if (entity.angle !== tracked.angle) {
      if (!finite(entity.angle)) entity.angle = tracked.angle;
      else if (kinematic) body.setNextKinematicRotation(entity.angle);
      else body.setRotation(entity.angle, true);
    }
    if (!kinematic && (entity.vx !== tracked.vx || entity.vz !== tracked.vz)) {
      if (finite(entity.vx) && finite(entity.vz)) body.setLinvel({ x: entity.vx, y: entity.vz }, true);
      else { entity.vx = tracked.vx; entity.vz = tracked.vz; }
    }
    if (!kinematic && entity.spin !== tracked.spin) {
      if (finite(entity.spin)) body.setAngvel(entity.spin, true);
      else entity.spin = tracked.spin;
    }
    if (typeof options.shape === 'function') {
      const shape = options.shape(entity);
      if (shapeKey(shape) !== tracked.shape) {
        s.refs.delete(tracked.collider.handle);
        s.rapier.removeCollider(tracked.collider, true);
        attach(s, collection, tracked, entity, shape);
      }
    }
    for (const prop in tracked.props) {
      const value = valueOf(options[prop as keyof BodyOptions<unknown>] as Value<Entity>, entity, DEFAULTS[prop]);
      if (value === tracked.props[prop]) continue;
      tracked.props[prop] = value;
      if (prop === 'density') tracked.collider.setDensity(value);
      else if (prop === 'friction') tracked.collider.setFriction(value);
      else if (prop === 'restitution') tracked.collider.setRestitution(value);
      else if (prop === 'linearDamping') body.setLinearDamping(value);
      else if (prop === 'angularDamping') body.setAngularDamping(value);
      else if (prop === 'gravityScale') body.setGravityScale(value, true);
      body.wakeUp();
    }
  }

  function syncStatics(s: State, world: W) {
    const list = config.statics?.(world) ?? [];
    const json = JSON.stringify(list);
    if (json === s.statics.json) return;
    for (const collider of s.statics.colliders) { s.refs.delete(collider.handle); s.rapier.removeCollider(collider, true); }
    s.statics = { json, colliders: [] };
    for (const item of list) {
      const desc = shapeDesc(item.shape).setTranslation(item.x ?? 0, item.z ?? 0).setRotation(item.angle ?? 0)
        .setSensor(!!item.sensor).setFriction(item.friction ?? DEFAULTS.friction).setRestitution(item.restitution ?? DEFAULTS.restitution);
      if (config.contacts) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const collider = s.rapier.createCollider(desc);
      s.statics.colliders.push(collider);
      s.refs.set(collider.handle, { ref: { collection: STATIC, id: item.key }, sensor: !!item.sensor });
    }
  }

  function step(ctx: PhysicsContext, dt: number) {
    if (!(dt > 0)) return;
    const s = state(ctx);
    const world = ctx.world as Record<string, Record<string, Entity> | undefined>;
    syncStatics(s, ctx.world as W);
    for (const collection of s.collections) {
      const items = world[collection.name] ?? {};
      const include = collection.options.include;
      for (const tracked of collection.tracked.values()) {
        const entity = items[tracked.id];
        if (!entity || (include && !include(entity))) remove(s, collection, tracked);
        else update(s, collection, tracked, entity);
      }
      // New entities in sorted id order: the same world always builds the same Rapier world.
      const added = Object.keys(items).filter(id => !collection.tracked.has(id) && items[id] && (!include || include(items[id]!))).sort();
      for (const id of added) create(s, collection, id, items[id]!);
    }
    s.rapier.timestep = dt / substeps;
    const contacts: PhysicsContact[] = [];
    for (let i = 0; i < substeps; i++) {
      s.rapier.step(s.events);
      // The queue is cleared by the next step: drain after every substep.
      s.events?.drainCollisionEvents((h1, h2, started) => {
        const a = s.refs.get(h1); const b = s.refs.get(h2);
        // A body removed while touching: its "stopped" event has nobody to report.
        if (!a || !b) return;
        const va = a.body?.linvel() ?? { x: 0, y: 0 }; const vb = b.body?.linvel() ?? { x: 0, y: 0 };
        contacts.push({ a: a.ref, b: b.ref, started, sensor: a.sensor || b.sensor, speed: Math.hypot(va.x - vb.x, va.y - vb.y) });
      });
    }
    for (const collection of s.collections) {
      const items = world[collection.name]!;
      for (const tracked of collection.tracked.values()) {
        const entity = items[tracked.id];
        const { body } = tracked;
        const at = body.translation(); const velocity = body.linvel();
        entity.x = tracked.x = at.x; entity.z = tracked.z = at.y;
        entity.vx = tracked.vx = velocity.x; entity.vz = tracked.vz = velocity.y;
        entity.angle = tracked.angle = body.rotation(); entity.spin = tracked.spin = body.angvel();
      }
    }
    for (const contact of contacts) ctx.trigger(CONTACT_EVENT, contact);
  }

  const entityOf = (ctx: WorldContext, collection: string, id: string) => (ctx.world as Record<string, Record<string, Entity> | undefined>)[collection]?.[id];

  function mass(ctx: WorldContext & Partial<PhysicsContext>, collection: string, id: string): number {
    const entity = entityOf(ctx, collection, id);
    const options = (config.bodies as Record<string, BodyOptions<Entity> | undefined>)[collection];
    if (!entity || !options) return 0;
    const tracked = ctx.resource ? holder(ctx as PhysicsContext).state?.collections.find(c => c.name === collection)?.tracked.get(id) : undefined;
    if (tracked && tracked.body.mass() > 0) return tracked.body.mass();
    const shape = typeof options.shape === 'function' ? options.shape(entity) : options.shape;
    return area(shape) * valueOf(options.density, entity, DEFAULTS.density);
  }

  return {
    system(options: { id?: string; phase?: SystemPhase; context?: (sim: any) => PhysicsContext } = {}) {
      const context = options.context ?? ((sim: PhysicsContext) => sim);
      return { id: options.id ?? 'physics', phase: options.phase ?? 'update', run: (sim: any, dt: number) => step(context(sim), dt) };
    },
    step,
    impulse(ctx, collection, id, impulse) {
      const entity = entityOf(ctx, collection, id);
      const type = (config.bodies as Record<string, BodyOptions<Entity> | undefined>)[collection]?.type ?? 'dynamic';
      if (!entity || type !== 'dynamic' || !finite(impulse.x) || !finite(impulse.z)) return false;
      const m = mass(ctx, collection, id);
      if (!(m > 0)) return false;
      entity.vx = (finite(entity.vx) ? entity.vx : 0) + impulse.x / m;
      entity.vz = (finite(entity.vz) ? entity.vz : 0) + impulse.z / m;
      return true;
    },
    setVelocity(ctx, collection, id, velocity) {
      const entity = entityOf(ctx, collection, id);
      if (!entity || !finite(velocity.x) || !finite(velocity.z)) return false;
      entity.vx = velocity.x; entity.vz = velocity.z;
      return true;
    },
    teleport(ctx, collection, id, at, options = {}) {
      const entity = entityOf(ctx, collection, id);
      if (!entity || !finite(at.x) || !finite(at.z)) return false;
      entity.x = at.x; entity.z = at.z;
      if (finite(options.angle)) entity.angle = options.angle;
      if (!options.keepVelocity) { entity.vx = 0; entity.vz = 0; entity.spin = 0; }
      return true;
    },
    mass,
    raycast(ctx, from, direction, maxDistance, options = {}) {
      const s = holder(ctx).state;
      const length = Math.hypot(direction.x, direction.z);
      if (!s || s.world !== ctx.world || !(length > 0) || !(maxDistance > 0)) return undefined;
      const dir = { x: direction.x / length, y: direction.z / length };
      const ray = new RAPIER.Ray({ x: from.x, y: from.z }, dir);
      const flags = options.sensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
      const hit = s.rapier.castRayAndGetNormal(ray, maxDistance, true, flags, undefined, undefined, undefined, collider => {
        const entry = s.refs.get(collider.handle);
        if (!entry) return false;
        if (options.exclude && entry.ref.collection === options.exclude.collection && entry.ref.id === options.exclude.id) return false;
        return !options.filter || options.filter(entry.ref);
      });
      const entry = hit && s.refs.get(hit.collider.handle);
      if (!hit || !entry) return undefined;
      const distance = hit.timeOfImpact;
      return { ...entry.ref, distance, point: { x: from.x + dir.x * distance, z: from.z + dir.y * distance }, normal: { x: hit.normal.x, z: hit.normal.y } };
    },
    reset(ctx) { const h = holder(ctx); free(h.state); h.state = undefined; },
    count(ctx) { return holder(ctx).state?.collections.reduce((sum, c) => sum + c.tracked.size, 0) ?? 0; },
  };
}
