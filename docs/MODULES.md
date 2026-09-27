# Feature modules

Modules are how several people (and their AIs) add content to the same game without touching each other's code or the core. A module is a directory:

```text
games/<game>/src/features/<module-id>/
  server.ts     required — definitions (+ behaviour hooks), runs on the server only
  client.ts     optional — custom 3D models and other browser-side extras
```

The server globs `../features/*/server.ts`, the client globs `../features/*/client.ts`; adding or deleting a directory is picked up by the dev server and by production deploys without editing any list.

## Anatomy of `server.ts`

```ts
import type { Feature } from '../../shared/types';

export default {
  // id: 'ola-swamp',            // optional: defaults to the directory name
  author: 'Ola',                 // shown in the catalog/UI; defaults to "anonymous"
  description: 'Bog creatures and a drought ability.',
  enemies: [ /* EnemyDef */ ],   // one array per module kind the game defines
  abilities: [ /* AbilityDef */ ],
} satisfies Feature;
```

`Feature` is `FeatureModule<Kinds>` from `@gaime/core`; `Kinds` is defined by each game in `src/shared/types.ts`:

| Game | Kinds |
| --- | --- |
| `blank` | `pickups` |
| `starter` (Crystal) | `enemies`, `abilities`, `waves` |
| `duel` | `weapons` |

Every definition has at least `id`, and by convention `name` and `description`. The rest is game-specific data plus optional hooks (functions) such as `tick`, `cast`, `start`, `onDeath`, `onImpact`, `onPickup`.

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

`createRegistry` returns:

| Field | Type | Use |
| --- | --- | --- |
| `kinds.<kind>[id]` | definition | look a definition up by id (e.g. `registry.kinds.enemies[enemy.kind]`) |
| `lists.<kind>` | definition[] | all definitions in stable (file path) order |
| `catalog` | `CatalogEntry[]` | JSON-safe copies for the client: every field except functions, plus `kind`, `feature`, `author`, `name`, `description` |
| `features` | `{ id, author, description, file }[]` | the modules themselves |
| `owner['<kind>/<id>']` | module id | who defined what |

It throws — with the file name — on: a missing default export, an invalid module id, duplicate module ids, an unknown kind key, a non-array kind, an invalid definition id (`^[a-z0-9][a-z0-9-]{0,63}$`), a duplicate definition id within a kind, or your `validate` throwing. A throwing registry makes the server code fail to load: locally you see the message in the terminal, in production the supervisor reverts to the previous version and reports "server code failed to load: …".

## The catalog on the client

Games put `registry.catalog` into the world in `prepare` (`world.catalog = registry.catalog`) and list `catalog` in `network.shared` (sent by reference when it changes, never saved in checkpoints). The client reads it:

```ts
const abilities = world.catalog.filter(entry => entry.kind === 'abilities');
const visual = world.catalog.find(entry => entry.kind === 'enemies' && entry.id === enemy.kind)?.visual;
```

Keep display data (name, description, icon, color, cost, visual) as plain fields on definitions so the UI can show it.

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

The game's `src/client/features.ts` collects these (`createFeatureModules`) and registers them on its `ModelLibrary`. `visual.scale`, `visual.lift` and `visual.color` still apply. A failing model factory falls back to a box and logs an error. Client modules must only import `three`, `@gaime/core/*` and `../../shared/*` — never server code.

## Rules for module authors

1. **Stable, prefixed ids.** Ids are written into saves and bound to players (`abilities: ['dash', 'pulse']`). Prefix with your module/author (`ola-bog`) and do not rename.
2. **State in data, not in variables.** Per-entity state goes to `entity.data['<module-id>-key']` (number/string/boolean). Module-level variables and timers are lost on hot reload and not saved.
3. **Time and randomness from the engine.** `sim.world.time`, `sim.dt`, `sim.random()`.
4. **Use the game's `Sim`.** Damage, spawning, effects and sounds through `sim.*` keep scoring, deaths and visuals consistent across modules.
5. **Cheap hooks.** A hook runs for every entity every tick; move heavy work to a worker ([SERVER.md](SERVER.md#heavy-processing-workers)).
6. **Complete features.** An enemy needs a wave that spawns it; a weapon needs a sensible default balance; everything needs a `name` and `description`.

## Removing a module

Delete its directory. On the next load `prepare` should clean up references (the templates remove entities of unknown kinds and rebind abilities/weapons to defaults) — do the same in your own games' `prepareWorld`.

## Designing module kinds (for game authors)

The kinds are your game's API for other contributors. Guidelines — and the step-by-step in `.claude/skills/gaime-module-kind/SKILL.md`:

- Data first, hooks optional: most modules should be a handful of numbers plus a `visual`.
- A default behaviour in the engine, overridable by a hook.
- Validate every field with a clear message.
- Two or three example modules per kind: plain, with a hook, with a custom model.
- Document the kind in the game's `AGENTS.md` and `docs/ADDING_FEATURES.md` with a complete example.
