# Bumper (games/bumper) — instructions for AI agents

A physics sumo arena: every player is a disc on a round arena, steering with WASD / the stick and dashing with Space. Push the others off the edge; the last disc standing wins the round. Late in a round the arena shrinks, so every round ends. It is the template for **games built on rigid-body physics** (`@gaime/physics`, Rapier 2D): the world stays plain JSON, the physics world is a derived resource rebuilt after a hot reload.

It is also the template for **session games**: `rooms: { mode: 'matches', size: 6 }` — many small arenas instead of one world; a new room when the open ones are full, private games by invite code (`?code=`), and the room is locked (`sim.lockRoom(true)`) while a round runs, so newcomers get another arena. Match worlds are not saved. See [../../docs/ROOMS.md](../../docs/ROOMS.md). Every round replays exactly from a flight recording, physics included (`gaime replay --room <id>`).

Read the general rules in [../../AGENTS.md](../../AGENTS.md), the model in [../../docs/SIMULATION.md](../../docs/SIMULATION.md) and the physics package in [../../docs/PHYSICS.md](../../docs/PHYSICS.md) first. How to extend this game: [docs/ADDING_FEATURES.md](docs/ADDING_FEATURES.md).

## Files

| File | What it shows |
| --- | --- |
| `src/shared/types.ts` | `World` (`match`, `arena`, `pickups`), `Player` (a physics `Body`: `x, z, vx, vz, angle, spin`), `Input`, `Command`; the bus: `Events` (incl. `physics.contact`), `Modifiers`; the `Sim`; the module kind `powerups` (`PowerupDef`); `Feature` |
| `src/shared/rules.ts` | constants (`RULES`), `player.data` keys (`DATA`), `dashLeft`, `powerupsOf` — shared by server, bots and HUD |
| `src/server/physics.ts` | `createPhysics<World>`: players are dynamic discs, density from `player.mass`, bodies only for `alive` players, contact events, 2 substeps |
| `src/server/simulation.ts` | `createWorld`, `createPlayer`, `prepareWorld`, `makeSim` (incl. `push`, `knockOut`, `spawnPickup`), `step` (steering), the systems (`runMatch`, `updateMass`, `ringOut`, `collect`, `shrink`, `spawn`, `referee`), the handlers, `command` (`ready`, `dash`), the bot brain |
| `src/server/game.ts` | `defineGame<World, Input, Sim, Events, Modifiers>`: network config, `spatial` (players, for the bots), the systems in tick order with `physics.system()`, `on` handlers, `keepPlayers: false` |
| `src/server/registry.ts` | module discovery + validation of `powerups` |
| `src/client/main.ts` | `GameClient` kept across HMR, `Controls` + `TouchControls` (stick + dash button), `GameUi` with a round/wins widget, dash meter and banners, sounds for forwarded events |
| `src/client/scene.ts` | top-down arena scaled to `world.arena`, discs spinning with `angle`, a powerup aura, falling discs; **every disc is interpolated, none predicted** |
| `src/features/heavy/server.ts` | content + rule: the `anvil` powerup and a `push.mass` modifier (triple density) |
| `src/features/turbo/server.ts` | content with a hook: the `turbo` powerup (`onCollect` kick) and `move.accel` / `dash.power` modifiers |
| `src/features/streak/server.ts` | behaviour only: a knockout gives the pusher a speed burst (`on` + `modify`) |
| `tests/simulation.test.ts` | `testGame` tests: knockout credit and scoring, steering and dash cooldown, lobby respawn, powerups, a bot round, determinism, a hot reload, a failing module switched off |

## Physics in this game

- A player's `x, z, vx, vz, angle, spin` are written by the physics step every tick. Game code changes them freely (steering adds to `vx`/`vz`, a dash adds a burst, `lineUp` teleports); the next step applies the change. See [PHYSICS.md](../../docs/PHYSICS.md).
- Only `alive` players have a body (`include`), so a knocked-out disc stops colliding at once.
- A disc's density is `player.mass`, refreshed every tick from the `push.mass` modifiers by the `mass` system — modules change weight through the modifier, never the physics.
- Physics code (`src/server/physics.ts`, `@gaime/physics`) is server-only. The client only reads the synced fields and interpolates them — no client-side prediction for physics bodies.

## One tick

The engine runs, in this order (see `src/server/game.ts`):

1. due timers fire (`player.respawn`);
2. `match` (input phase): kit `stepMatch` — countdown / start (everyone lined up on the start ring) / timeout;
3. `step`: steering adds `move.accel` × stick × dt to each alive disc's velocity (not during the countdown);
4. systems: `mass` (density from `push.mass`) → `physics` (Rapier step; contacts become `physics.contact`) → `ring-out` (discs past the edge → `player.knocked`) → `collect` (powerups) → `shrink` (arena, late in a round) → `spawn` (every `RULES.spawnEvery` s) → module systems → `referee` (late: ≤ 1 disc left ends the round);
5. events triggered along the way reach the `on` handlers — the game's first, then modules' in file order.

## Events (`Events` in `src/shared/types.ts`)

| Event | Payload | Triggered by | Handled by |
| --- | --- | --- | --- |
| `physics.contact` | `{ a, b, started, sensor, speed }` (`a`/`b` = `{ collection, id }`) | the physics step | the game: remembers who hit whom (`DATA.hitBy/hitAt`), triggers `player.bumped` |
| `player.bumped` | `{ a, b, speed }` | a contact faster than `RULES.bumpSpeed` | forwarded (sound, shake) |
| `player.knocked` | `{ player, by }` — `by` = last toucher within `RULES.creditSeconds`, or null | `ring-out`, `sim.knockOut`, a disconnect during a round | the game: feed line, respawn timer outside rounds; `streak`; forwarded |
| `player.respawn` | `{ player }` | timer `player:<id>:respawn` (outside rounds) | the game puts the disc back |
| `dash.used` | `{ player, power }` — `power` after `dash.power` | the `dash` command | forwarded (sound) |
| `round.countdown` | `{ seconds }` | `match` | forwarded |
| `round.started` | `{ round, players }` | `match` | forwarded |
| `round.won` | `{ round, player }` — null = draw | `referee`, or `match` on timeout | the game adds a win, restores the arena and respawns everyone; forwarded |
| `pickup.spawned` | `{ pickup, kind }` | `sim.spawnPickup` | — (free for modules) |
| `pickup.collected` | `{ player, pickup, kind }` | `collect` (after the status and `onCollect`) | forwarded (sound) |

Plus the engine's events: `player.joined`, `player.online`, `player.offline` (a knockout during a round), `player.removed`.

## Modifiers (`Modifiers`)

| Modifier | Value | Data | Used in |
| --- | --- | --- | --- |
| `dash.power` | velocity a dash adds (`RULES.dash`) | `{ player }` | the `dash` command |
| `push.mass` | disc density (1) | `{ player }` | the `mass` system, every tick |
| `move.accel` | steering acceleration (`RULES.accel`) | `{ player }` | `step` |

## The `Sim`

| Member | Use |
| --- | --- |
| `world`, `dt`, `random()` | the world; seconds since the last run; seeded randomness |
| `trigger`, `after`, `cancel`, `modify`, `log`, `emit`, `isolate` | the bus, timers, modifiers, feed, client events, module isolation |
| `resource(key, create, dispose?)` | a derived, unsaved value (the physics world lives here; `physics.system()` needs it) |
| `fighters()` | players still on the arena |
| `push(playerId, impulse)` | an impulse (mass × Δv): heavy discs move less |
| `knockOut(playerId, by?)` | out for the round, triggers `player.knocked` |
| `spawnPickup(kind?, at?)` | place a powerup (random weighted kind and position by default) |

## Module kind `powerups` (`PowerupDef`)

| Field | Meaning |
| --- | --- |
| `id`, `name`, `description` | stable, prefixed id; player-facing texts |
| `weight` | relative spawn chance |
| `duration` | seconds of the status `powerup:<id>` in `player.data` (kit `status`) — modifiers check it |
| `visual` | `Visual` of the pickup; its `color` also tints the disc's aura while active |
| `onCollect?(sim, player, pickup)` | an extra effect, run through `sim.isolate` (a throwing hook switches its module off) |

A powerup's effect is usually a `modify` entry in the same module that checks `status.active(player.data, 'powerup:<id>', sim.world.time)`.

## Testing

```ts
const t = testGame(game, { random: seeded(1) });
const ada = t.join('Ada'); const bob = t.join('Bob');
t.command(ada, { type: 'ready' }); t.command(bob, { type: 'ready' });
t.run(RULES.countdownSeconds + 0.2);                   // the round is on
Object.assign(t.player(bob), { x: RULES.arena - 1.2, z: 0 });
Object.assign(t.player(ada), { x: RULES.arena - 4, z: 0, vx: 20 });
t.run(2, () => t.world.match.phase === 'ended');
expect(t.triggeredOf('player.knocked')).toEqual([{ player: bob, by: ada }]);
```

`npx vitest run games/bumper`. Physics is deterministic: the same seed and inputs give the same round (there is a test). `t.engine.dispose()` simulates a hot reload (the physics world is rebuilt from the JSON).
