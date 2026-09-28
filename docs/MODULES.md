# Feature modules

Modules are how several people (and their AIs) add content and behaviour to the same game without touching each other's code or the core. A module is a directory:

```text
games/<game>/src/features/<module-id>/
  server.ts     required — definitions and/or behaviour (on, modify, systems, commands), runs on the server only
  client.ts     optional — custom 3D models and other browser-side extras
```

The server globs `../features/*/server.ts`, the client globs `../features/*/client.ts`; adding or deleting a directory is picked up by the dev server and by production deploys without editing any list.

The mechanisms a module plugs into — events, modifiers, timers, systems, commands, isolation — are explained in [SIMULATION.md](SIMULATION.md). This page is about the module file and the registry.

## Anatomy of `server.ts`

A module can contribute two things: **definitions** (content of the game's module kinds) and **behaviour** (code the engine runs).

```ts
import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

export default {
  // id: 'ola-swamp',            // optional: defaults to the directory name
  author: 'Ola',                 // shown in the catalog; defaults to "anonymous"
  description: 'Bog creatures that slow players, and a bounty for killing them.',

  // definitions: one array per module kind the game defines
  enemies: [ /* EnemyDef */ ],
  waves: [ /* WaveDef */ ],

  // behaviour: optional, any combination
  on: {                                           // react to the game's events
    'enemy.died': ({ kind, by }, sim) => { if (kind === 'ola-bog' && by) sim.world.players[by].gold += 5; },
  },
  modify: {                                       // adjust values other code asks for
    'player.damage': (amount, { player }, sim) => status.active(sim.world.players[player].data, 'ola-mud', sim.world.time) ? amount * 0.8 : amount,
  },
  systems: [                                      // per-tick or periodic work
    { id: 'bubbles', every: 3, run: sim => { /* … */ } },
  ],
  commands: {                                     // new player actions
    'ola-swamp-dive': (playerId, command, sim) => { /* validate, act, or return a refusal */ },
  },
} satisfies Feature;
```

`Feature` is `FeatureModule<Kinds, Sim, Events, Modifiers>` from `@gaime/core`, defined by each game in `src/shared/types.ts`, so handler and modifier names and their payloads are type-checked against the game's `Events` and `Modifiers` — a misspelled name is a compile error:

| Game | Kinds | Events / modifiers |
| --- | --- | --- |
| `blank` | `pickups` | `pickup.spawned`, `pickup.collected`, `pickup.expired` / `pickup.points` |
| `starter` (Crystal) | `enemies`, `abilities`, `waves` | see `games/starter/src/shared/types.ts` |
| `duel` | `weapons` | see `games/duel/src/shared/types.ts` |
| `bumper` | `powerups` | `player.knocked`, `round.won`, `dash.used`, `physics.contact`… / `dash.power`, `push.mass`, `move.accel` |

Every definition has at least `id`, and by convention `name` and `description`. The rest is game-specific data plus optional hooks (functions) such as `tick`, `cast`, `start`, `onDeath`, `onImpact`, `onPickup`.

### Behaviour keys

| Key | Shape | Runs |
| --- | --- | --- |
| `on` | `{ [event]: (data, sim) => void }` | after the code that triggered the event, same tick — the game's handlers first, then modules in file order. Keys: the game's `Events`, the engine's `player.joined` / `player.online` / `player.offline` / `player.removed`, or a private `<module>:<event>` |
| `modify` | `{ [name]: (value, data, sim) => value }` | synchronously inside `ctx.modify(name, value, data)`, in the same order; returning `undefined` keeps the value |
| `systems` | `[{ id, phase?, every?, run(sim, dt) }]` | every tick (or every `every` seconds of world time) in its phase: `input` → the game's `step` → `update` (default) → `late`; the game's systems before modules' |
| `commands` | `{ [type]: (playerId, command, sim) => string \| void }` | when a client (or `ctx.command`) sends a command of that `type`; a returned string is a private reply |

**Private events.** A module can trigger, schedule and handle its own events without editing the game's types: name them `<module>:<event>` (`ola-bomb:fuse`). Their payload is untyped — validate it. Anything other modules may want to react to belongs in the game's `Events` instead.

```ts
// src/features/ola-bomb/server.ts
commands: {
  'ola-bomb-plant': (playerId, _command, sim) => {
    const player = sim.world.players[playerId];
    if (!player) return;
    sim.after(3, 'ola-bomb:fuse', { x: player.x, z: player.z, by: playerId });
  },
},
on: {
  'ola-bomb:fuse': (data, sim) => { /* explode at data.x, data.z — through the game's Sim helpers */ },
},
```

(Whether `sim.after` accepts private names depends on the game's `Sim`; the engine's `ctx.after` / `ctx.trigger` always do.)

**Modifiers run on the server only.** Don't use them for values the client predicts (movement speed, collision size) — derive those in a shared function from world data instead, or the player rubber-bands ([SIMULATION.md](SIMULATION.md#modifiers)).

The engine validates these when the registry is built — `on`/`modify`/`commands` must be objects of functions, `systems` an array of `{ id, run }` with a valid, unique id (`^[a-z0-9][a-z0-9-]{0,63}$`), a known `phase` and a positive `every`; a command type may be handled by one module only and must not start with `$`. A violation makes the server code fail to load, with the file name in the message.

### Reserved keys

`id`, `author`, `description`, `on`, `modify`, `systems` and `commands` are not definition kinds. Every other key must be one of the game's kinds, and a game cannot name a kind after a reserved key.

### Behaviour-only modules

A module does not need definitions. `games/blank/src/features/combo/server.ts` is pure behaviour — it reacts to `pickup.collected` and doubles `pickup.points` inside a two-second window:

```ts
export default {
  author: 'gaime',
  description: 'Combo: a pickup collected within 2 s of the previous one is worth double.',
  on: {
    'pickup.collected': ({ playerId }, sim) => {
      const player = sim.world.players[playerId];
      if (player) status.apply(player.data, 'combo', sim.world.time, 2);
    },
  },
  modify: {
    'pickup.points': (points, { playerId }, sim) => {
      const player = sim.world.players[playerId];
      return player && status.active(player.data, 'combo', sim.world.time) ? points * 2 : points;
    },
  },
} satisfies Feature;
```

Rules, scoring variants, achievements, bounties, weather, events that change the whole arena — anything that reacts to what happens rather than adding a new thing — fit this shape. Nothing in the game's core changes.

## The registry

`games/<game>/src/server/registry.ts`:

```ts
import { createRegistry } from '@gaime/core';
import type { Feature, Kinds } from '../shared/types';

const modules = import.meta.glob<{ default: Feature }>('../features/*/server.ts', { eager: true });

export const registry = createRegistry<Kinds>(modules, {
  kinds: ['enemies', 'abilities', 'waves'],
  validate: {
    enemies(def) { if (!(def.hp > 0)) throw new Error(`enemies/${def.id}: hp must be positive.`); },
  },
});
```

The game hands it to the engine with `defineGame({ features: registry, … })` — that is what makes the modules' `on`, `modify`, `systems` and `commands` run. `createRegistry` returns:

| Field | Type | Use |
| --- | --- | --- |
| `kinds.<kind>[id]` | definition | look a definition up by id (e.g. `registry.kinds.enemies[enemy.kind]`) |
| `lists.<kind>` | definition[] | all definitions in stable (file path) order |
| `catalog` | `CatalogEntry[]` | JSON-safe copies for the client: every field except functions, plus `kind`, `feature`, `author`, `name`, `description` |
| `features` | `{ id, author, description, file }[]` | the modules themselves |
| `owner['<kind>/<id>']` | module id | who defined what — the owner to pass to `ctx.isolate` |
| `handlers`, `modifiers`, `systems`, `commands` | behaviour by owner | read by the engine through `features`; you rarely touch them |

It throws — with the file name — on: a missing default export, an invalid module id, duplicate module ids, an unknown kind key, a non-array kind, an invalid definition id (`^[a-z0-9][a-z0-9-]{0,63}$`), a duplicate definition id within a kind, invalid behaviour (see above), a command type claimed twice, or your `validate` throwing. A throwing registry makes the server code fail to load: locally you see the message in the terminal, in production the supervisor reverts to the previous version and reports "server code failed to load: …".

## Isolation

Code owned by a module runs isolated: if a module's handler, modifier or system throws, **that module is switched off** — its behaviour stops, a ⚠ line in the feed names it, `/health` lists it under `disabled` — and the rest of the game keeps running. The next code load (a pushed fix) switches it back on. A switched-off module's commands answer with a refusal; an exception inside a module command only becomes an error reply to that player.

**Definition hooks** (`tick`, `cast`, `onPickup`, `onImpact`…) are called by the game's code, so the game must run them under the module's name — otherwise a bug in one module's hook pauses the whole game:

```ts
// games/blank/src/server/simulation.ts
if (def.onPickup) sim.isolate(registry.owner[`pickups/${def.id}`], () => def.onPickup!(sim, player, pickup));
```

`isolate` returns `undefined` when the hook failed or the module is off, so the game can fall back to a default behaviour:

```ts
const owner = registry.owner[`enemies/${def.id}`];
if (def.tick && sim.isolate(owner, () => { def.tick!(sim, enemy); return true; })) continue;
defaultAi(sim, enemy);
```

Tests are strict: in `testGame` a module error throws instead of switching the module off, so it fails the test ([TESTING.md](TESTING.md)).

## The catalog on the client

Games put `registry.catalog` into the world in `prepare` (`world.catalog = registry.catalog`) and list `catalog` in `network.shared` (sent by reference when it changes, never saved in checkpoints). The client reads it:

```ts
const abilities = world.catalog.filter(entry => entry.kind === 'abilities');
const visual = world.catalog.find(entry => entry.kind === 'enemies' && entry.id === enemy.kind)?.visual;
```

Keep display data (name, description, icon, color, cost, visual) as plain fields on definitions so the client can show them however the game chooses to.

## `client.ts`: custom models

```ts
import * as THREE from 'three';
import type { ClientFeature } from '../../client/features';

export default {
  models: {
    golem(visual) {                       // used by any definition with visual.shape === 'golem'
      const group = new THREE.Group();
      // … build a model ~1 unit tall, standing on y = 0, facing +Z
      return group;
    },
  },
} satisfies ClientFeature;
```

The game's `src/client/features.ts` collects these (`createFeatureModules`) and registers them on its `ModelLibrary`. `visual.scale`, `visual.lift` and `visual.color` still apply. A failing model factory falls back to a box and logs an error. Client modules must only import `three`, `@gaime/core/*` and `../../shared/*` — never server code. (This applies to games that render with the `@gaime/core/three` helpers; a game with its own renderer defines its own client module shape.)

## Rules for module authors

1. **Stable, prefixed ids.** Module ids, definition ids, system ids, command types (`<module>-<action>`), private events (`<module>:<event>`) and timer keys are written into saves or shared between modules. Prefix them with your module/author (`ola-bog`, `ola-swamp-dive`, `ola-swamp:bubble`, `ola-swamp:<entity>:burn`) and do not rename.
2. **State in data, not in variables.** Per-entity state goes to `entity.data['<module-id>-key']` (number/string/boolean). Module-level variables, `setTimeout` and `setInterval` are lost on hot reload and not saved; timers are `sim.after` / `ctx.after`.
3. **React, don't reach in.** Listen to the game's events (`on`), adjust its values (`modify`), add work with `systems` and actions with `commands`. Do not call another module's functions or edit the game's central files to "register" yours.
4. **Time and randomness from the engine.** `sim.world.time`, `sim.dt`, `sim.random()`.
5. **Use the game's `Sim`.** Damage, spawning, effects and sounds through `sim.*` keep scoring, deaths and events consistent across modules.
6. **Cheap code.** A system or handler may run for every entity every tick; use `every` for periodic work and move heavy work to a worker ([SERVER.md](SERVER.md#heavy-processing-workers)). `/gaime/stats` → `parts` shows what each module costs.
7. **Complete features.** An enemy needs a wave that spawns it; a weapon needs a sensible default balance; everything needs a `name` and `description`.

## Removing a module

Delete its directory. Its behaviour disappears with the next code load. `prepare` should clean up references to its definitions (the templates remove entities of unknown kinds and rebind abilities/weapons to defaults) — do the same in your own games' `prepareWorld`. Timers the module scheduled stay in `world.schedule` and still fire their events; with no handler left they do nothing, but cancel them in `prepare` (`ctx.cancel('<module-id>:', { prefix: true })`) if they would reach a handler that should no longer see them.

## Designing module kinds (for game authors)

The kinds, events and modifiers are your game's API for other contributors. Guidelines — and the step-by-step in `.claude/skills/gaime-module-kind/SKILL.md`:

- Data first, hooks optional: most modules should be a handful of numbers plus a `visual`.
- A default behaviour in the engine, overridable by a hook — and run every hook through `sim.isolate(owner, …)`.
- Trigger events for everything other modules may want to react to (`enemy.died`, `wave.started`, `pickup.collected`) and route adjustable numbers through `modify` (`player.damage`, `pickup.points`). Declare both in `src/shared/types.ts` (`Events`, `Modifiers`) with a comment per entry, and pass them to `FeatureModule` and `defineGame`.
- Validate every field with a clear message.
- Two or three example modules per kind: plain, with a hook, with a custom model — plus a behaviour-only module if the game has events worth reacting to.
- Document the kinds, events and modifiers in the game's `AGENTS.md` and `docs/ADDING_FEATURES.md` with complete examples.
