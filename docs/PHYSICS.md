# Physics (`@gaime/physics`)

Rigid-body physics for gaime games, on [Rapier 2D](https://rapier.rs) (`@dimforge/rapier2d-compat`, WebAssembly inlined — nothing to serve or copy). Bodies are ordinary entities of the world, so everything the framework guarantees still holds: **the world stays plain JSON** (synced, saved in checkpoints, hot-reload safe), and the Rapier world is a **derived resource** (`ctx.resource`) kept alive across ticks and rebuilt from the JSON after a hot reload, a restart or a restored save.

`games/bumper` (a sumo arena) is the complete example.

```ts
// src/server/physics.ts — server only (never import it from the client)
import { createPhysics } from '@gaime/physics';
import type { World } from '../shared/types';

export const physics = createPhysics<World>({
  gravity: { x: 0, z: 0 },                   // top-down: none. Side views (z = up): { x: 0, z: -20 }
  bodies: {                                  // top-level Record<id, entity> collections of the world
    players: { shape: { circle: 0.5 }, linearDamping: 1.5, restitution: 0.9, density: p => p.mass, include: p => p.alive },
    crates: { shape: { box: [1, 1] } },
    doors: { type: 'kinematic', shape: { box: [4, 0.5] } },
  },
  statics: world => [{ key: 'pillar', shape: { circle: 1 }, x: 0, z: 0 }],   // rebuilt when this JSON changes
  contacts: true,                            // trigger 'physics.contact' on the bus
});

// src/server/game.ts
defineGame<World, Input, Sim, Events, Modifiers>({
  systems: [
    { id: 'steer', run: steer },
    physics.system<Sim>(),                   // phase 'update' (options: id, phase, context)
    { id: 'ring-out', run: ringOut },        // reads the new positions
  ],
  on: { 'physics.contact': ({ a, b, started, speed }, sim) => { /* … */ } },
});
```

## Entities: the JSON fields

Every entity of a body collection carries plain numbers the physics reads and writes:

| Field | Meaning |
| --- | --- |
| `x`, `z` | position on the world plane (Rapier's y is the world's z) |
| `vx`, `vz` | linear velocity, units/s |
| `angle` | rotation in radians, counter-clockwise from +x towards +z (Three.js: `object.rotation.y = -angle`) |
| `spin` | angular velocity, rad/s |

Missing fields are added with `0` when the body is created. Extend `Body` from the package in your entity types: `interface Player extends BasePlayer, Body { … }`.

## One physics step

`physics.system()` (or `physics.step(ctx, dt)`) does, every tick:

1. **statics**: if `statics(world)` returns a different JSON than last time, the static colliders are rebuilt;
2. **sync JSON → Rapier**, per collection in config order: bodies of deleted entities (or ones `include` rejects) are removed; **changes game code made** since the last step are applied — a different `x`/`z`/`angle` teleports the body, a different `vx`/`vz`/`spin` sets its velocity; function-valued properties (`density: p => p.mass`, `shape: e => …`) are re-read and applied when they change; new entities get bodies in **sorted id order**;
3. **Rapier steps** `substeps` times with the engine's fixed `dt` (`dt / substeps` each);
4. **write back** `x, z, vx, vz, angle, spin` of every body into its entity;
5. **contacts** (with `contacts: true`): every collision start/stop becomes `ctx.trigger('physics.contact', …)` — after the system, like any event.

So game code never talks to Rapier: **steer by adding to `vx`/`vz`, teleport by setting `x`/`z`**, and the next step applies it. Invalid numbers (`NaN`, `Infinity`) written by game code are replaced by the physics state instead of poisoning the simulation.

## API

| | |
| --- | --- |
| `createPhysics<World>(config)` | `bodies` (per collection: `type` `dynamic`/`kinematic`/`fixed`, `shape`, `density`, `friction`, `restitution`, `linearDamping`, `angularDamping`, `gravityScale`, `lockRotation`, `ccd`, `sensor`, `include`), `statics`, `gravity`, `contacts`, `substeps`, `key` |
| shapes | `{ circle: radius }`, `{ box: [width, depth] }` (full size), `{ polygon: [[x, z], …] }` (convex hull, local points) — or a function of the entity |
| `physics.system(options?)` | the engine system; `{ id?, phase?, context? }`. Its `sim` must provide `world`, `resource` and `trigger` (a `GameContext` does; add `resource` to your `Sim`, or pass `context: sim => …`) |
| `physics.step(ctx, dt)` | one step, for games that step manually |
| `physics.impulse(ctx, collection, id, { x, z })` | adds `impulse / mass` to the entity's velocity (heavy bodies move less) |
| `physics.setVelocity(ctx, collection, id, v)` / `teleport(ctx, collection, id, at, { keepVelocity?, angle? })` | the same as writing the fields; teleport stops the body unless `keepVelocity` |
| `physics.mass(ctx, collection, id)` | the body's mass (from Rapier, or shape area × density) |
| `physics.raycast(ctx, from, direction, maxDistance, { exclude?, sensors?, filter? })` | the first collider along a ray as of the last step: `{ collection, id, point, normal, distance }` or `undefined`; sensors skipped unless `sensors: true` |
| `physics.reset(ctx)` / `physics.count(ctx)` | drop the Rapier world (rebuilt on the next step) / bodies in it |

The `physics.contact` payload (`PhysicsContact`) — add `'physics.contact': PhysicsContact` to your `Events`:

```ts
{ a: { collection: 'players', id: 'p1' }, b: { collection: 'static', id: 'pillar' }, started: true, sensor: false, speed: 7.4 }
```

`a`/`b` are entities (`collection`, `id`) or static colliders (`collection: 'static'`, `id`: their key). `speed` is the bodies' relative speed right after the step — a rough impact strength for sounds and damage. A body removed while touching reports no "stopped" event.

Give your `Sim` facade helpers that go through the physics (`push(playerId, impulse)` in Bumper) so modules never import the package.

## Determinism

Rapier is deterministic for the same operations in the same order, and the package keeps the order fixed: collections in config order, new bodies by sorted id, one step per tick with the engine's fixed `dt`. With `testGame(game, { seed: n })` (or `random: seeded(n)`) the same inputs give **bit-identical** results — the physics tests and Bumper's tests check it (two runs compared with `JSON.stringify`).

A rebuilt Rapier world (after a hot reload or restart) continues from the JSON, which holds positions, velocities and rotations exactly. What is lost is solver warm-starting and sleep state: bodies in free flight continue identically, bodies in resting or ongoing contact may resolve a few millimetres differently. That is invisible in play; it just means "restart the server" is not bit-reproducible, while "run the same test twice" — and replaying a flight recording (below) — is.

## Recordings and replays

The engine's flight recorder ([SIMULATION.md](SIMULATION.md#determinism-and-replays)) keeps the last minutes of a session as segments, each starting from a world snapshot. The world JSON alone would not be enough for a physics game: a replay that starts mid-round would rebuild Rapier from positions and velocities and lose the solver's warm-starting, contact and sleep state — so bodies in contact could resolve slightly differently and the replay would report a divergence.

So the physics resource uses `ResourceOptions.save` / `load` ([CONFIG.md](reference/CONFIG.md#gamecontext)):

- `save` puts Rapier's complete snapshot (`World.takeSnapshot()`, base64) plus the package's bookkeeping (which entity owns which body and collider, the last synced values, static colliders) into each segment's engine state (`state.resources['gaime-physics']`, or your `key`).
- `load` restores that snapshot when `replay()` starts from the segment, and the next step continues from it **bit for bit** — even when the recording starts in the middle of a round.

Nothing to do in the game: use `physics.system()` (or `physics.step(ctx, dt)` with the engine's `dt`) and let the resource live in `ctx.resource`, as the package does. `games/bumper/tests/simulation.test.ts` records a session with short segments, so the oldest ones are dropped and the replay has to start mid-round, and checks that it matches exactly. The snapshot only goes into recordings, never into checkpoints — a restart still rebuilds from the JSON as described above.

## Hot reload, restarts, rooms

- The Rapier world lives in `ctx.resource('gaime-physics', …)`: created on the first step, disposed (and its WebAssembly memory freed) when the code is replaced, rebuilt from the JSON on the next step. Nothing to do in `prepare` or `migrate`.
- If the world object itself is replaced (a restored save), the resource notices and rebuilds.
- Every room (`rooms: { mode: 'matches' }`) has its own engine, so its own physics world.
- `RAPIER.init()` runs once per process (top-level `await` in the package), in dev (Vite SSR), in production builds and in tests.
- Physics is server code: keep `createPhysics` in `src/server/`. `import type { Body, PhysicsContact } from '@gaime/physics'` in `src/shared/types.ts` is fine (types only).

## On the client

Physics bodies are **not predicted**: the client interpolates the synced `x`/`z`/`angle` (`Interpolator(['angle'])`, `ServerClock`, ~100 ms behind) for every body, the player's own included. Collisions with other moving bodies cannot be predicted correctly, and a mispredicted collision looks worse than 100 ms of latency. For a snappier own character, predict only its steering and blend towards the server (see `games/blank/src/client/scene.ts`) — Bumper deliberately does not.

Network size: positions and velocities are rounded for the wire by `network.precision` (default 0.01 for `x`, `z`, `vx`, `vz`, `angle`); add `spin: 10` (and similar) for other fields. A body at rest produces no patches.

## Performance

Measured with `npm run bench -w @gaime/physics` (Apple M2 Pro, Node 26; one step = JSON sync + Rapier + write-back, `dt` = 1/30 s, discs bouncing in a closed arena):

| Scene | ms per step |
| --- | --- |
| 100 dynamic bodies | 0.09 |
| 300 dynamic bodies | 0.22 |
| 300 bodies + contact events | 0.20 |
| 300 bodies, 2 substeps | 0.31 |
| 300 bodies packed 4× denser + contacts | 0.29 |
| 1000 dynamic bodies | 0.55 |

A tick has ~33 ms, so physics is rarely the bottleneck; what costs more is what your handlers do per contact. The whole Bumper tick with 4 bots is ~0.02–0.06 ms. `/gaime/stats` → `parts` shows the physics system as `game/physics`.

## Side views and gravity

The plane is always `x`/`z`. For a platformer or an artillery game seen from the side, treat `z` as up and set `gravity: { x: 0, z: -20 }`; `gravityScale` per collection (or per entity) makes balloons and rockets. Characters usually want `lockRotation: true` and `friction`; walls and floors are `statics` or a `fixed` collection; moving platforms are `kinematic` bodies you move by writing `x`/`z` (they push dynamic bodies and report contacts).

## When not to use physics

- **Characters that must feel crisp** (twin-stick shooters, platformers with tight controls): kit movement (`moveTopDown`, `clampToRect`, `separate`) is predictable on the client and has no solver jitter. Use physics for the things that should tumble.
- **Hitscan and simple projectiles**: kit `raycast` and `stepProjectiles` are cheaper and fully under your control.
- **Grid, turn-based and card games**: no continuous motion, no physics.
- **Thousands of tiny particles or pure visuals**: do them on the client only; the server world should hold what matters for the rules.
- **Only overlap tests** ("is the player in the zone?"): a distance check or `ctx.near` is simpler than sensors.
