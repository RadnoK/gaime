# Troubleshooting

Symptoms, causes and fixes, grouped by where you notice them. Deploy-specific checks are also in [DEPLOYMENT.md](DEPLOYMENT.md#troubleshooting).

## First look

| Where | What it tells you |
| --- | --- |
| The terminal running `npm run dev` | server errors, module load errors, stack traces |
| The browser console | client errors, HMR messages (`[vite] hot updated …`) |
| F3 in the game | connection, ping, patch rate and size |
| `http://localhost:5173/health` | loaded version, last code error, `disabled` modules |
| `http://localhost:5173/gaime/stats` | tick cost, `parts` (which system / handler / command eats the tick), `droppedMs`, engine counters |
| The game feed | engine messages (⚠ pauses, ⚠ switched-off modules, deploys, joins) |
| `npx gaime status` (supervisor) | deploy history, failed commits, paused updates |
| `npx gaime world <key>` | the live world, e.g. `npx gaime world players` |

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
- Typical causes: a handler assuming an entity still exists (events carry ids; the entity may be gone by the time the handler runs — check), a field missing on old entities, a modifier returning `NaN`.

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
| Lag for everyone as the game grows | `npm run load`: `server.tickMsMax` above the budget; `/gaime/stats` → `parts` names the system, handler or command that costs the most (`msPerSecond`, `maxMs`) | make that part cheaper: spatial queries (`SpatialHash`), `every` for AI and spawners, fewer entities, heavy work to a worker (`ctx.job`) |
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
- `npx gaime smoke` tells you whether the problem is the room/network or your game.
- Framework bugs: see the `gaime-engine` skill and add a failing test in `packages/core/tests`.
