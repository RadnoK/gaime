# Troubleshooting

Symptoms, causes and fixes, grouped by where you notice them. Deploy-specific checks are also in [DEPLOYMENT.md](DEPLOYMENT.md#troubleshooting).

## First look

| Where | What it tells you |
| --- | --- |
| The terminal running `npm run dev` | server errors, module load errors, stack traces |
| The browser console | client errors, HMR messages (`[vite] hot updated …`) |
| F3 in the game | connection, ping, patch rate and size |
| `http://localhost:5173/health` | loaded version, last code error, `disabled` modules |
| `http://localhost:5173/gaime/stats` | tick cost, `parts` (which system / handler / command eats the tick), `throttled` (modules over their time budget), `droppedMs`, engine counters |
| The game feed | engine messages (⚠ pauses, ⚠ switched-off modules, ⚡ throttled modules, deploys, joins) |
| `npx gaime status` (supervisor) | deploy history, failed commits, paused updates |
| `npx gaime world <key>` | the live world, e.g. `npx gaime world players` |
| `npx gaime replay --list` | flight recordings saved after errors (and by `gaime replay`) — replay the last minutes offline ([below](#replaying-a-live-bug)) |

## The game is paused with ⚠

An exception was thrown in the game's own code — `step`, one of the game's systems, handlers or modifiers, a bot brain, `prepare`, a job result — or in a definition hook the game calls **without** `ctx.isolate`. The engine paused the simulation instead of crashing; the message is in the feed and in `/health` (`error`).

- Find the stack trace in the dev server terminal (or `docker compose logs game`).
- Fix and save/push: the next code load resumes the game automatically. Without a code change the host can `/resume` (it pauses again if the error repeats).
- Typical causes: a definition id that no longer exists (`registry.kinds.enemies[e.kind]` is `undefined` after a module was removed — handle it in `prepareWorld`), a field missing on old saved entities (give it a default), division by zero producing `NaN` positions.

If the failing code is a module's definition hook (`def.tick`, `def.onPickup`…), the game should call it through `sim.isolate(registry.owner['<kind>/<id>'], …)` — then the next such bug switches only that module off ([MODULES.md](MODULES.md#isolation)).

An exception in a **command** or **request** does not pause the game; only its author gets an error notice. `ctx.command` (bots, scripted events) never throws either: it returns `Error in the code of command "<type>": <message>` as the reply, and the stack trace is in the server log.

## A module was switched off

The feed shows `⚠ Module "<id>" was switched off after an error: <message>`, and `/health` lists it:

```sh
curl -s localhost:5173/health | jq .disabled        # { "ola-swamp": "Cannot read properties of undefined (reading 'hp')" }
```

A handler, modifier or system of that module (or a hook the game ran through `ctx.isolate`) threw. The engine skips everything the module contributes — handlers, modifiers, systems; its commands answer "switched off" — and the rest of the game keeps running. Nothing is paused.

- The stack trace is in the server log (`[gaime] module <id>`).
- Reproduce it: `testGame` is strict by default, so the same situation throws in a test with a full stack.
- Push a fix: the next code load switches the module back on (the list in `/health` empties). There is no manual "switch on" — a module that fails again is switched off again.
- The server also saved a flight recording of the minutes before (`[gaime] replay saved: …` in the log, `npx gaime replay --list`): replay it to watch the module fail ([Replaying a live bug](#replaying-a-live-bug)).
- Typical causes: a handler assuming an entity still exists (events carry ids; the entity may be gone by the time the handler runs — check), a field missing on old entities, a modifier returning `NaN`.

## A module is over its time budget

The feed shows `⚡ Module "<id>" is over its time budget: its systems now run every <n> ticks.`, and `/gaime/stats` lists it:

```sh
curl -s localhost:5173/gaime/stats | jq '{throttled, parts}'      # { "throttled": { "ola-swarm": 4 }, "parts": [...] }
```

The module's systems and handlers together cost more than its budget (`budget.moduleMs`, default 20% of the tick — 6.7 ms at 30 Hz), averaged over a second. The engine now runs its **systems** only every 2nd, 4th or at most 8th tick (with a correspondingly larger `dt`); its event handlers and modifiers still run every time, so nothing is lost — but whatever the systems do (movement, AI, spawning) looks choppier. When the cost drops well below the budget, the factor halves again and the feed says `Module "<id>" is back within its time budget.`

- `parts` names the expensive system or handler (`<id>/<system>`, `<id> on <event>`) with `msPerSecond` and `maxMs`.
- Typical causes: every entity × every entity (use the [spatial index](SIMULATION.md#spatial-index): `spatial` + `ctx.near`, and `separateWith` for crowds), AI thinking every tick (a system with `every: 0.2`), heavy work in a handler that fires often, a big search (move it to a worker).
- The game's own code is never throttled; a slow game `step` shows up as `droppedMs` instead ([Performance](#performance)).
- Budgets measure wall-clock time, so they are off in tests; `testGame(game, { budget: true })` turns them on.
- A game that knowingly runs one expensive module can raise the budget (`budget: { moduleMs: 12 }`) or turn it off (`budget: { enabled: false }`).

## Event storm

`Event storm: more than 50000 events at once (last: "<event>"). Does a handler trigger the event it handles?` — the bus stopped a loop. The code that raised the last event failed: its module was switched off (or the game paused, when it was game code), and the queued events of that tick were dropped.

- Look for a handler of `<event>` that triggers `<event>` again (directly or through a chain: A → B → A).
- React to a fact once: guard with state (`if (enemy.data['ola-exploded']) return;`) or trigger a different, more specific event.
- Chains that are legitimate but large (splitting enemies, chain lightning) should do their work in a loop inside one handler, or spread over ticks with timers, instead of one event per step.

## Timers do not fire

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing happens at all | the world is paused (`world.pause`), time does not advance | resume; in tests `t.run` does nothing while paused (`testContext`'s `advance` ignores the pause) |
| The event fires but nothing reacts | no `on` handler for that exact event name, or the handler's module is switched off | check the name (typos, old names in saved timers); `/health` → `disabled` |
| A timer disappears | scheduled again with the same key (it replaces the old one), cancelled by a prefix (`cancel('enemy:1', { prefix: true })` also matches `enemy:10`…), or keyed `player:<id>:` and the player was removed | give keys a terminating separator (`enemy:1:`), unique suffixes, and check who cancels what |
| `ctx.every` does not restart after a change | the same key, event and interval keep the running timer on purpose | use another key, or `ctx.cancel(key)` first |
| A timer fires late under load | more than 5 000 timers were due in one tick; the rest fire on the next ticks | expected; spread large batches (different delays) |
| Inspect them | — | `npx gaime world schedule` (the live heap: `live` has key → time, event), or `ctx.timeLeft(key)` / `ctx.timers(prefix)` in code and tests |

## Things happen in the wrong order

- **Systems**: phases run `input` → the game's `step` → `update` (default) → `late`; inside a phase the game's systems come first, then modules' systems in module (file) order, each in declaration order. Put reading-after-everything work (cleanup, clamping, scoring) in `late`, input-like work in `input`.
- **Periodic systems** (`every`) are staggered and restart their rhythm after every code load; do not rely on two of them running on the same tick.
- **Handlers** run after the code that triggered the event finishes (never in the middle of it) — the game's handlers first, then modules' in file order. If a value looks stale inside a system right after `trigger`, that is why: read the result in a later phase or in the handler itself.
- **Modifiers** run in the same order; each gets the previous result. A multiplying modifier and an adding one give different results depending on order — design modifiers so the order does not matter much (clamp at the end in the game code).

## The server code does not load

`Failed to load server module` / `server code failed to load: …` — something throws while importing, before the room can run: the registry (duplicate or invalid ids, unknown kind, your `validate`), a top-level statement in a module, a syntax error.

- Locally: the terminal shows the file and message; the old code keeps running until you fix it.
- On the server: the supervisor reverts to the previous version and marks the commit as failed; push a fix.

## Replaying a live bug

The server keeps a flight recording of the last minutes (`GameDefinition.record`, default 10). It is saved to `<data>/replays/` by itself when the game pauses on an error or a module is switched off (at most once a minute), and on demand:

```sh
cd games/<game>
npx gaime replay "bots stuck at wave 3"     # → Saved …/replays/<time>-bots-stuck-at-wave-3.json
npx gaime replay --list
```

Copy the file into the repository (outside `.gaime/`, e.g. `games/<game>/tests/fixtures/`; do not commit real player data) and replay it with the **same code version** (`recording.version`; `git checkout <version>` in a scratch worktree if the code has moved on):

```ts
import { readFileSync } from 'node:fs';
import { replay } from '@gaime/core/server';
const recording = JSON.parse(readFileSync('tests/fixtures/replay.json', 'utf8'));
const result = replay(game, recording, {
  onTick: (world, tick) => { if (tick === 18_450) debugger; },   // stop just before it goes wrong
});
expect(result.diverged).toBeUndefined();
```

The replay starts from the oldest snapshot in the recording and runs the exact same ticks, so the error that paused the game (or switched the module off) happens again at the same tick — its stack trace is logged (`[gaime] simulation` / `[gaime] module <id>`), the world pauses (`result.world.pause`) or the module shows up in `result.engine.disabledModules`, and you can set breakpoints and add logging around it.

### A replay diverges

`result.diverged = { tick, expected, actual }` is the first check where the replayed world differs from the recorded one (checks every 150 ticks — 5 s at 30 Hz — plus every segment snapshot). Something in the simulation is not deterministic, or the code differs:

| Cause | Fix |
| --- | --- |
| `Math.random()` in simulation code (a module, a helper, a kit call given `Math.random`) | `ctx.random()` / `sim.random()` — the world's generator |
| `Date.now()`, `performance.now()`, `new Date()` deciding game logic | `world.time` / `world.tick` |
| module-level variables, caches, counters, closures holding state | state in the world (`entity.data`), derived state in `ctx.resource` (rebuilt from the world) |
| iteration over something unordered that is not the world (a `Set` of ids built from async results, object keys that are numbers vs strings added in different order) | sort, or iterate the world's own records |
| a `ctx.resource` with state that is not in the world and not saved | give it `save`/`load` ([SIMULATION.md](SIMULATION.md#resources)), or make it derivable from the world |
| different code: the recording was made by another commit, or local edits | replay with the recorded version |
| the test replays a run made with `testGame(game, { random: seeded(n) })` | record with `{ seed: n }` instead — `random` bypasses `world.rng` |

Bisect with `onTick`: hash or dump the part of the world you suspect every tick, in the live run (a test that records) and in the replay, and compare — or replay twice with `until` set before and after the reported tick and diff `JSON.stringify(result.world)` of both runs. The divergence happened somewhere in the 150 ticks before `diverged.tick`.

`diverged.actual === 'the game stayed paused'`: the replay paused on an error that did not happen live (or earlier) — usually the same non-determinism, or a code difference; the error is in `result.world.pause.message`.

### A recording is incomplete

`recording.reason` ends with `(incomplete: …)`:

- `code ran outside the tick (outside())` — something changed the world outside the recorded entry points: `t.act(…)` in a test, or custom code calling `engine.outside`. Such changes cannot be replayed. In tests, drive the game through `t.input`, `t.command`, `t.admin`, `t.request`, `t.join`, `t.addBot` when you want a replayable recording; on a server, change the world through commands, requests or admin commands, never from `routes` (Express handlers bypass the recorder entirely, without even marking it).
- `a "<type>" entry is not serialisable` — a command, request payload or job result held something `structuredClone` cannot copy (a function, a class with private fields). Keep payloads and job results plain data.

Everything recorded before that point still replays; after it the replay drifts.

### Physics replays

Games using `@gaime/physics` replay exactly, even from a snapshot in the middle of a round: the physics resource saves Rapier's full snapshot (contacts, warm starting, sleeping bodies) with every segment through `ResourceOptions.save`/`load`. If a physics game diverges, look for the usual causes above first; then check that the physics system runs through `physics.system()` / `physics.step(ctx, dt)` with the engine's `dt` (a custom step size or a second step per tick breaks it), and that game code does not keep its own Rapier objects outside the resource ([PHYSICS.md](PHYSICS.md#recordings-and-replays)).

## Hot reload problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every client edit reloads the page | `main.ts` lost its literal `import.meta.hot.accept()` (it must be written exactly like that, not through a helper or alias) | put it back; see [CLIENT.md](CLIENT.md) |
| After an edit: two canvases, doubled sounds, events handled twice | something was created outside the `Scope` or listeners registered without `scope.add(...)` | create everything through `scope`; `net.off()` in dispose; keep long-lived objects with `keep(import.meta.hot, key, …)` |
| A server edit resets a module's counter/timer | state held in a module-level variable, or a `setTimeout` | move it into the world (`entity.data`) or use an engine timer (`ctx.after`) — timers live in `world.schedule` and survive reloads |
| A new field is `undefined` in the running game | the world was created before the field existed and it is not in `createWorld()` | add the default to `createWorld()` / `createPlayer()` — `hydrate` fills it on reload |
| A new `features/<id>` directory is not picked up | the file is not named exactly `server.ts` / `client.ts`, or the default export is missing | check the name; the dev terminal shows registry errors |
| Changes to `vite.config.ts`, `package.json` or `tsconfig.json` have no effect | these are not hot-reloadable | restart `npm run dev` (the supervisor restarts by itself) |
| Express routes (`game.routes`) do not update | routes are registered once per process | restart |
| Workers keep running old code in production | expected — worker pools are recreated on the next code load; in dev they reload with the Vite graph | — |

## Players, identity, connection

| Symptom | Cause | Fix |
| --- | --- | --- |
| Two tabs control the same character | same browser identity | use `?player=2` for a second local player |
| A player is called `Ola 2` | another player (online or offline) already had the name `Ola` (case-insensitive) | expected; `/nick` to pick another free name |
| A returning player keeps the old name and sees "The nickname … is taken" | the name typed in the lobby belongs to someone else | pick another name |
| "Taken over in another tab" | the same identity joined elsewhere (close code 4103) | expected; the newest tab wins |
| "Removed from the game" | kicked (`/kick`, `gaime kick`) or removed by the game (close code 4102) | rejoin |
| Players rejoin as new characters after a deploy | the game `name` in `defineGame` changed (it keys the room, checkpoint and localStorage) | never rename it; change the title instead |
| A client reconnects in a loop | server paused/restarting, or protocol version mismatch after a framework update (the page reloads itself when `/health` shows a new version) | check `/health`; hard-reload the page |
| Movement stutters | missing interpolation for remote entities, or prediction disagreeing with the server | use `Interpolator`; share movement code between server and client (`src/shared/rules.ts`) |
| The local player rubber-bands | prediction uses different speed/collision than the server | the same function with the same parameters on both sides (see the Tag tutorial's `speedOf`) |
| Input seems ignored | `parseInput` returns `undefined` for your input shape, or the input lease expired (client not repeating) | log the parsed input; use `GameClient.input()` every frame |

## Performance

| Symptom | Where to look | Fix |
| --- | --- | --- |
| Lag for everyone as the game grows | `npm run load`: `server.tickMsMax` above the budget; `/gaime/stats` → `parts` names the system, handler or command that costs the most (`msPerSecond`, `maxMs`) | make that part cheaper: the engine's spatial index (`spatial` + `ctx.near`), `every` for AI and spawners, fewer entities, heavy work to a worker (`ctx.job`) |
| One feature gets choppy, `⚡ … over its time budget` in the feed | `/gaime/stats` → `throttled` | [A module is over its time budget](#a-module-is-over-its-time-budget) |
| The game runs slow-motion for a moment | `/gaime/stats` → `droppedMs` > 0: ticks took so long that the clock dropped time (catch-up limit 3 ticks) | same as above; find the spike with `parts` → `maxMs` |
| Sounds/effects missing under load | `/gaime/stats` → `engine.droppedEvents` grows: more than 256 client events per client per tick | forward fewer events (`network.events`), emit one summarising event instead of one per entity |
| High bandwidth / big patches | F3 or load report `patchBytesMax` | list big dictionaries in `network.entities`, prune effect arrays, `hidden` for server-only fields, lower `precision`, raise `publishEvery` |
| Low FPS in the browser | devtools performance tab | reuse geometries/materials (`ModelLibrary`, `sharedMaterial`), fewer shadow-casting lights, dispose what you remove (`EntityLayer` does) |
| Event loop delay | `/gaime/stats` `eventLoopDelayMs` | a synchronous heavy function on the server — move it to a worker |

Details: [PROTOCOL.md](PROTOCOL.md) and the `gaime-networking` skill.

## Saves and data

| Symptom | Cause | Fix |
| --- | --- | --- |
| The world resets after a restart | the checkpoint is not written (read-only data dir) or `GAIME_DATA_DIR` differs between runs | check the log and the directory |
| `Corrupt checkpoint` / the game refuses to save | the file could not be parsed; the engine runs "frozen" and never overwrites it | stop the game, restore from `backups/` or `.gaime/<game>/snapshots`, start again |
| Old saves break after a change | a field changed meaning or type | bump `SCHEMA` and write `migrate` ([COOKBOOK.md](COOKBOOK.md#changing-saved-data)) |
| Start fresh locally | — | stop the dev server and delete `games/<game>/.gaime/data` (never on a server — use `gaime admin`/a migration there) |

## Deploys

| Symptom | Check |
| --- | --- |
| A push does not arrive | `gaime status` (paused? failed?), supervisor logs, deploy key: `git fetch` inside the container |
| `failed … gate` | `npm run check` locally; with `GAIME_GATES=check,test` also `npm test` |
| Deployed but the page shows the old version | release mode reloads via `/health`; live mode uses HMR — behind a proxy `GAIME_PUBLIC_URL` must be the exact public address (https → wss) |
| Rollback done, but new pushes are ignored | after `rollback` updates stay paused: `gaime resume` |
| A second `rollback` fails with `There is no previous version to roll back to.` | there is one step back only (no ping-pong); push a fix or `git revert` |
| A control command prints `Requested "…" — the supervisor has not handled it yet` | the supervisor is busy with a deploy; it runs the command afterwards — follow `gaime status` |
| Admin commands hit the wrong game or fail with a 401 | the CLI uses the port from `host.json` only while that supervisor runs, and tries every token file it finds; otherwise set `GAIME_URL` and/or `GAIME_ADMIN_TOKEN` explicitly |
| 503 from the gateway | the game is starting or crashed; `docker compose logs game` |
| Changes to `packages/host` not active | the supervisor itself is not hot-reloaded: `docker compose restart game` |

## Typecheck and build

| Error | Fix |
| --- | --- |
| `Cannot find module '@gaime/core/…'` | the subpath must be one of `server`, `client`, `three`, `kit`, `ui`, `audio`, `worker`, `vite`; run `npm install` after adding a game |
| A client file imports server code | client code may only import `three`, `@gaime/core/*` (browser parts) and `src/shared/*` |
| `npm run build` fails for one game only | `npm run build:game -- <game>` (or `cd games/<game> && npx vite build`) to see its error |
| Types of a module do not match | `satisfies Feature` shows which field; compare with the game's `Kinds` in `src/shared/types.ts` |

## Still stuck

- Reproduce in a logic test with `testGame` ([TESTING.md](TESTING.md)) — the same engine as the server, strict about errors, the fastest loop. `testGame(game, { world: savedWorld })` starts from a copy of the live world (`npx gaime world > /tmp/world.json`).
- Or replay the last minutes exactly: `npx gaime replay` and [Replaying a live bug](#replaying-a-live-bug).
- `npx gaime smoke` tells you whether the problem is the room/network or your game.
- Framework bugs: see the `gaime-engine` skill and add a failing test in `packages/core/tests`.
