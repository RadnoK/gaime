---
name: gaime-module-kind
description: Add a new kind of feature module to a gaime game (e.g. "turrets", "power-ups", "maps", "cards", "events") — the extension point other people's AIs will use. Use when requested content does not fit any existing module kind of the game.
---

# Add a module kind (a new extension point)

A kind = a key in the game's `Kinds` type + a registry entry + engine code that uses the definitions + UI that shows them + docs. Other contributors will write many modules against it, so design it as a small, stable API.

## 1. Design the definition

Write the type in `games/<game>/src/shared/types.ts`:

```ts
export interface TurretDef {
  id: string;
  name: string;
  description: string;
  cost: number;
  range: number;
  fireInterval: number;        // seconds
  damage: number;
  visual: Visual;
  /** Optional custom behaviour; replaces the default "shoot the nearest enemy". */
  tick?(sim: Sim, turret: Turret): void;
}
export type Kinds = { enemies: EnemyDef; abilities: AbilityDef; waves: WaveDef; turrets: TurretDef };
```

Guidelines:

- Data first, functions optional: most modules should only need numbers + `visual`. Provide a sensible default behaviour in the engine and an optional hook (`tick`, `onHit`, `onImpact`, `cast`) for special ones.
- Every field that the client shows must be JSON (it goes to `world.catalog`); functions are stripped from the catalog automatically.
- Hooks receive `Sim` (services) and the entity; they must not keep state outside `entity.data`.
- If the kind creates world entities (turrets on the map), add an entity type with `id`, `kind` (the def id), position, and `data: Record<string, number|string|boolean>`, stored as `world.<plural>: Record<string, Entity>`.

## 2. Register and validate

`games/<game>/src/server/registry.ts`:

```ts
export const registry = createRegistry<Kinds>(modules, {
  kinds: ['enemies', 'abilities', 'waves', 'turrets'],
  validate: {
    turrets(def) {
      if (!(def.cost >= 0)) throw new Error(`turrets/${def.id}: "cost" must be ≥ 0.`);
      if (!(def.range > 0 && def.fireInterval > 0)) throw new Error(`turrets/${def.id}: "range" and "fireInterval" must be positive.`);
    },
  },
});
```

Validation errors surface in the dev console and make a production deploy revert — make the messages say exactly what to fix.

## 3. Use it in the simulation

- World: add the entity dictionary to `World` and `createWorld()` (old saves get it automatically via hydrate — no migration needed for a new field).
- `network.entities` in `defineGame`: add the new dictionary so it is diffed per entity.
- `prepareWorld`: delete entities whose `kind` is no longer in the registry (a module was removed).
- `step`: run the default behaviour or the hook for each entity; wrap nothing in try/catch (the engine isolates errors and pauses the game with a message).
- `command`: the player-facing action (e.g. `{ type: 'build', turret, x, z }`) — validate everything (known id, cost, placement, cooldown).
- `Sim`: expose any new service module code will need (e.g. `sim.nearestEnemy`).

## 4. Show it on the client

- Render entities with an `EntityLayer` keyed by `kind` + visual (see `games/starter/src/client/scene.ts`), looks from `world.catalog.find(e => e.kind === 'turrets' && e.id === entity.kind)`.
- UI to choose/use definitions (build menu, card hand, weapon bar): list `world.catalog.filter(e => e.kind === 'turrets')`, show `name`, `description`, `author`.

## 5. Seed it and document it

- Add 2–3 example modules in `src/features/` (plain / with hook / with custom model).
- Update `games/<game>/AGENTS.md` (kinds table) and `docs/ADDING_FEATURES.md` (one full example module).
- Test: registry loads the examples; the default behaviour works; a command validates input.

```sh
npm run check && npx vitest run games/<game>
```

## Pitfalls

- Renaming a kind or its fields later breaks everyone's modules — pick names carefully now.
- Don't put balance constants in the engine that modules can't override; put them on the definition with defaults.
- The catalog is `shared` (sent by reference, never saved): keep it that way when you add kinds.
