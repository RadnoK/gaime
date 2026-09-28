---
name: gaime-module-kind
description: Add a new kind of feature module to a gaime game (e.g. "turrets", "power-ups", "maps", "cards", "events") — the extension point other people's AIs will use. Use when requested content does not fit any existing module kind of the game.
---

# Add a module kind (a new extension point)

A kind = a key in the game's `Kinds` type + a registry entry + game code that uses the definitions + events and modifiers around them + a way for the client to show them + docs. Other contributors will write many modules against it, so design it as a small, stable API.

First check the idea really needs new content. "When X happens, do Y" or "change how much Z is worth" is not a kind — it is a behaviour-only module (`on` / `modify` / `systems` / `commands`, see `gaime-feature`), possibly after adding an event or modifier with `gaime-mechanic`.

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
- Hooks receive `Sim` (services) and the entity; they must not keep state outside `entity.data`. Anything that must happen later goes through timers (`sim.after`), not hook-local counters.
- Name the kind anything except the reserved module keys (`id`, `author`, `description`, `on`, `modify`, `systems`, `commands`) — the registry refuses those.
- If the kind creates world entities (turrets on the map), add an entity type with `id`, `kind` (the def id), position, and `data: Record<string, number|string|boolean>`, stored as `world.<plural>: Record<string, Entity>`.

## 2. Events and modifiers for the kind

Add to `Events` / `Modifiers` in `types.ts` what other modules will want around the new content, with a comment each:

```ts
export type Events = {
  // …
  'turret.built': { turret: string; kind: string; by: string };
  'turret.fired': { turret: string; target: string };
  'turret.destroyed': { turret: string; kind: string };
};
export type Modifiers = {
  // …
  'turret.cost': { player: string; kind: string };
  'turret.damage': { turret: string; kind: string };
};
```

Trigger each event in exactly one place (a `Sim` helper such as `buildTurret` / `destroyTurret`), and compute each adjustable number through `sim.modify`. Then a module can add "turrets cost 20% less for engineers" or "a destroyed turret explodes" without touching your code. Forward the ones clients need for sounds and effects (`network.events`).

## 3. Register and validate

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

## 4. Use it in the simulation

- World: add the entity dictionary to `World` and `createWorld()` (old saves get it automatically via hydrate — no migration needed for a new field).
- `network.entities` in `defineGame`: add the new dictionary so it is diffed per entity.
- `prepareWorld`: delete entities whose `kind` is no longer in the registry (a module was removed), and cancel their timers.
- A **system** (`defineGame({ systems: [{ id: 'turrets', run: sim => runTurrets(sim, registry) }] })`, or with `every` if turrets think a few times per second) runs the default behaviour or the hook for each entity. Run every hook **isolated under its module**, so a broken hook switches that module off instead of pausing the game, and fall back to the default:

  ```ts
  const owner = registry.owner[`turrets/${def.id}`];
  if (def.tick && sim.isolate(owner, () => { def.tick!(sim, turret); return true; })) continue;
  defaultTurret(sim, turret);          // no hook, the hook failed, or the module is switched off
  ```

  No try/catch of your own — `isolate` is the try/catch.
- Timed behaviour per entity (fire interval): kit `cooldown` in `turret.data`; one-shot delays (build time, self-destruct): timers keyed `turret:<id>:…`, cancelled with `ctx.cancel('turret:<id>:', { prefix: true })` when the turret is removed.
- `command`: the player-facing action (e.g. `{ type: 'build', turret, x, z }`) — validate everything (known id, cost via `sim.modify('turret.cost', …)`, placement, cooldown).
- `Sim`: expose any new service module code will need (e.g. `sim.nearestEnemy`, `sim.destroyTurret`).

## 5. Show it on the client

The game's authors decide how the kind looks and how players pick it; the framework only delivers the data.

- Entities: render them from the world, looks from `world.catalog.find(e => e.kind === 'turrets' && e.id === entity.kind)` (with the optional Three.js helpers: an `EntityLayer` keyed by `kind` + visual, like `games/blank/src/client/scene.ts`).
- Choosing/using definitions (build menu, card hand, weapon bar): list `world.catalog.filter(e => e.kind === 'turrets')`, show `name`, `description`, `author` in whatever interface the game has.

## 6. Seed it and document it

- Add 2–3 example modules in `src/features/` (plain / with hook / with custom model), plus one behaviour-only module that uses the new events or modifiers.
- Update `games/<game>/AGENTS.md` (kinds, events and modifiers tables) and `docs/ADDING_FEATURES.md` (one full example module per shape).
- Test with `testGame`: the registry loads the examples; the default behaviour works; a hook runs; the events fire (`t.triggeredOf('turret.fired')`); a command validates input; with `strict: false`, a throwing hook switches only its module off (`t.disabled`).

```sh
npm run check && npx vitest run games/<game>
```

## Pitfalls

- Renaming a kind or its fields later breaks everyone's modules — pick names carefully now.
- Don't put balance constants in the engine that modules can't override; put them on the definition with defaults.
- The catalog is `shared` (sent by reference, never saved): keep it that way when you add kinds.
- A hook called without `isolate` makes every module bug pause the whole game.
- Events renamed later break modules and pending timers — name them carefully now.

## Reference

`docs/MODULES.md#designing-module-kinds-for-game-authors`, `docs/MODULES.md#isolation`, `docs/SIMULATION.md`, `docs/SERVER.md`.
