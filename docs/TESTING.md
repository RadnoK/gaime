# Testing

Four layers, from fastest to most realistic. Run the first two before every push — the server runs the typecheck as a deploy gate anyway, and a failing push is reverted.

| Layer | Command | What it proves | Time |
| --- | --- | --- | --- |
| Types | `npm run check` | everything compiles (the deploy gate) | ~10 s |
| Logic | `npm test` / `npx vitest run games/<game>` | rules, events, timers, systems, modules, rounds, bots, saves — on the real engine (`testGame`) | seconds |
| End to end | `npx gaime smoke [--hmr]` (in `games/<game>`) | real WebSocket clients: sync, commands, reconnect, takeover, hot reload | ~10 s |
| Load | `npm run load -- <game> --bots 50` | latency, bandwidth, tick cost under load | 20 s+ |

Plus the browser for everything visual (see [the checklist](#browser-checklist)).

## Logic tests

Game logic runs in vitest without a server or network. Tests live in `games/<game>/tests/*.test.ts` and are picked up by the root `vitest.config.ts`. There are two tools:

- **`testGame(game)`** — the primary one. It runs the whole game on the **same `Engine` the server runs**: the fixed-step clock, timers, the event bus, systems, `step`, modifiers, module handlers and commands, bots, jobs and the player lifecycle. What passes here behaves the same live.
- **`testContext(world)`** — a bare `GameContext` for unit tests of one function (a kit helper, a `Sim` helper, a command) without a game definition.

### The setup every template uses

```ts
// games/blank/tests/simulation.test.ts
import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testGame } from '@gaime/core/server';
import { game } from '../src/server/game';
import { registry } from '../src/server/registry';
import { RULES } from '../src/shared/rules';

const setup = () => testGame(game, { random: seeded(1) });

test('pickups spawn up to the limit and give points when touched', () => {
  const t = setup();
  const ada = t.join('Ada');
  t.run(RULES.spawnEvery * (RULES.maxPickups + 3));              // seconds of game time
  expect(Object.keys(t.world.pickups).length).toBe(RULES.maxPickups);
  const pickup = Object.values(t.world.pickups)[0];
  Object.assign(t.player(ada), { x: pickup.x, z: pickup.z });
  t.tick();
  expect(t.player(ada).score).toBe(registry.kinds.pickups[pickup.kind].value);
  expect(t.events).toContainEqual({ name: 'pickup.collected', data: expect.objectContaining({ playerId: ada }) });
});

test('uncollected pickups expire (a timer saved in the world)', () => {
  const t = setup();
  t.join('Ada');
  t.run(RULES.spawnEvery + 0.1);
  const first = Object.keys(t.world.pickups)[0];
  t.run(RULES.pickupLife);
  expect(t.world.pickups[first]).toBeUndefined();
  expect(t.triggeredOf('pickup.expired')).toContainEqual({ pickup: first });
});
```

### `testGame(game, options?)`

| Member | Use |
| --- | --- |
| `join(name, id?)` | a human player joins (created on first join, online afterwards); returns the id (`p1`, `p2`… by default). The first one becomes the host |
| `leave(id)` / `remove(id)` | go offline / be removed like a kick or a freed seat (`onPlayerRemoved`, timers keyed `player:<id>:` cancelled) |
| `addBot(name?)` | a bot driven by `game.bot` every tick (needs `bot`) |
| `input(id, input)` | hold an input for a player until changed; `input(id, undefined)` releases it |
| `tick(count = 1)` | advance `count` ticks |
| `run(seconds, until?)` | advance `seconds` of game time; stops early when `until()` returns true; returns the ticks run |
| `command(id, command)` | send a command (routed to a module's `commands` or the game's `command`); returns the reply |
| `chat(id, text)` | a chat line or slash command, as the player |
| `request(id, name, payload?)` | call `game.requests[name]` |
| `admin(name, ...args)` | an operator command (`game.admin[name]`) |
| `recording()` | the flight recording so far (with `record: true`) — pass it to `replay(game, recording)` |
| `flushJobs()` | await pending `ctx.job` work and apply it |
| `world`, `player(id)`, `ctx` | the live world, one player, the engine's `GameContext` (`t.ctx.timeLeft(key)`, `t.ctx.timers(prefix)`) |
| `act(run)` | run code against the game's `Sim` like a system would — the events it triggers are handled right after: `t.act(sim => sim.spawnPickup('coin', t.player(ada)))` |
| `sim(dt = 0)` | the game's `Sim`, for reading (events triggered through it wait for the next piece of work — use `act` to change things) |
| `triggered`, `triggeredOf(event)` | every bus event in dispatch order (`{ event, data }`), or the payloads of one event |
| `events` | client events: `ctx.emit` and bus events forwarded by `network.events` (`{ name, data, playerId? }`) |
| `notices` | private notices (`{ playerId, text }`) |
| `feed()` | feed texts, newest last |
| `disabled` | modules switched off after an error (with `strict: false`) |
| `clear()` | empty `triggered`, `events` and `notices` |
| `engine` | the `Engine` itself, for framework tests |

| Option | Default | Use |
| --- | --- | --- |
| `seed` | random | seed of the world's generator (`world.rng`, behind `ctx.random`): the same seed plays the same game. Prefer it to `random` |
| `random` | the world's generator | replace `ctx.random` altogether (e.g. `seeded(n)`); such a run cannot be replayed |
| `record` | `false` | keep a flight recording for `t.recording()` (`true`, or `{ maxEntries }` to force early segment rotation). Drive the game through `input`, `command`, `join`, `addBot`, `admin`, `request` — `act` cannot be recorded and marks the recording incomplete |
| `budget` | `false` | enforce module time budgets (they measure wall-clock time, so they are off in tests) |
| `world` | `createWorld()` | start from this world instead — it is hydrated and migrated like a save (test old saves, or reproduce a live world) |
| `strict` | `true` | errors in module and game code **throw** (from `t.tick`, `t.run`, `t.command`…), so a broken module fails the test instead of being switched off and a broken command fails instead of replying with an error. Set `false` to test isolation itself (`t.disabled`, `t.world.pause`, error replies) |

### `testContext(world, options?)`

A `GameContext` on the engine without a game definition — for pure unit tests of functions that take `ctx`:

| Returned | Contents |
| --- | --- |
| `ctx` | pass to the function under test; `ctx.log` writes to `world.feed` |
| `notices` | `{ playerId, text }[]` from `ctx.notify` |
| `events` | `{ name, data, playerId? }[]` from `ctx.emit` |
| `triggered` | `{ event, data }[]` from `ctx.trigger` and fired timers — recorded, **no handlers run** (there is no game) |
| `advance(seconds)` | move `world.time` forward tick by tick and fire the timers that become due (also while the world is paused); their events land in `triggered` |
| `removed` | ids passed to `ctx.removePlayer` |
| `flushJobs()` | awaits `ctx.job` work and applies the results, like the next tick would |

| Option | Default | Use |
| --- | --- | --- |
| `random` | the world's generator (`world.rng`) | pass `seeded(n)`, or set `world.rng` for a fixed sequence |
| `command` | ignored | route `ctx.command(id, command)` |

`ctx.addBot` throws here — use `testGame` for bots. Anything that depends on handlers, systems or modules belongs in a `testGame` test.

### What to test

- **A full cycle**: a round, a wave, a match from lobby to result, with `t.run(seconds, until)`. Assert on counters (`wins`, `round`, `score`) rather than on phases that may last one tick.
- **Events and timers**: `t.triggeredOf('enemy.died')` shows what happened and in which order; `t.ctx.timeLeft('bomb:e1')` shows what is scheduled; `t.run(3)` makes it fire.
- **Commands refuse invalid use**: not the host, not your turn, not enough gold, dead players. A returned string is the refusal message (`expect(t.command(bob, { type: 'reset-scores' })).toMatch(/host/)`).
- **Modules**: every kind has definitions (`registry.lists.enemies.length > 0`); a behaviour module changes the outcome it promises (blank's combo test places pickups with `t.act(sim => sim.spawnPickup('coin', t.player(ada)))` and checks that two quick ones score 1 + 2); engine events reach handlers (`t.join` triggers `player.joined` and `player.online`); `prepareWorld` cleans up references to removed definitions. Since tests are strict, a throwing handler or hook fails the test.
- **Saves**: an old-shaped world survives `hydrate` + `migrate`:

  ```ts
  const old = { schema: 1, players: { a: { id: 'a', name: 'Ada', coins: 3 } } };
  const t = testGame(game, { world: old });
  expect(t.player('a').gold).toBe(30);
  ```

- **Bots**: bot versus bot until someone wins is an end-to-end test of your rules, with no mocking:

  ```ts
  const t = testGame(game, { random: seeded(3) });
  t.addBot('A'); t.addBot('B');
  t.run(600, () => Object.values(t.world.players).some(p => p.wins > 0));
  expect(Object.values(t.world.players).reduce((sum, p) => sum + p.wins, 0)).toBe(1);
  ```

- **Determinism**: record a session with humans, bots and commands and replay it — the worlds must match byte for byte. Every template has this test; it catches `Math.random()`, `Date.now()` and module-level state the day they appear:

  ```ts
  import { replay, testGame } from '@gaime/core/server';
  const t = testGame(game, { seed: 5, record: true });
  const ada = t.join('Ada'); t.addBot();
  for (let s = 0; s < 30; s++) { t.input(ada, { mx: Math.sin(s), mz: 0 }); t.run(1); }
  const result = replay(game, JSON.parse(JSON.stringify(t.recording())));
  expect(result.diverged).toBeUndefined();
  expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
  ```

  `replay(game, recording, { until?, onTick? })` returns `{ world, engine, ticks, verified, diverged? }`: `verified` counts the checks that matched (a world hash every 150 ticks plus every segment snapshot), `diverged` is the first one that did not ([CONFIG.md](reference/CONFIG.md#testgame-and-replay)). Physics games replay exactly even from a snapshot in the middle of a round — `games/bumper/tests` checks it with short segments (`{ ...game, record: { minutes: 0.05 } }`).
- **A live bug**: download the recording the server saved (`gaime replay`, or automatically after an error — see [SIMULATION.md](SIMULATION.md#determinism-and-replays)), replay it in a test with `onTick` to stop where it goes wrong, and keep it as a regression test. When it diverges instead: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#a-replay-diverges).
- **Jobs**: call the code that uses `ctx.job`, `await t.flushJobs()`, then assert the applied result. The job function itself runs inline in tests (workers only exist in a server process); test worker functions directly by importing them.
- **Kit usage**: pure functions — call them with plain objects.

Examples: `games/blank/tests` (spawning, collecting, the combo module, expiring timers, the host-only command, a bot); `games/starter/tests` and `games/duel/tests` for bigger games.

### Running

```sh
npm test                                   # everything (framework + all games)
npx vitest run games/duel                  # one game
npx vitest run games/duel -t "two bots"    # one test
npx vitest games/duel                      # watch mode
```

Logs from inside the simulation (`ctx.log`) go to `world.feed`, not the console — print `t.feed()` when a test fails.

## End to end: `gaime smoke`

Against a running dev server (`npm run dev -- <game>`) or any URL:

```sh
cd games/<game>
npx gaime smoke                          # http://localhost:5173 (or GAIME_URL / GAIME_PORT)
npx gaime smoke --hmr                    # also touches the server entry and checks the reload
npx gaime smoke https://game.example.com # a deployed game (joins as a real player for a few seconds)
```

It checks, printing a ✓ per step:

1. two clients join, get the welcome snapshot and entity patches;
2. commands are accepted and stream patches arrive;
3. a dropped connection reconnects with the same identity;
4. a second connection with the same browser identity takes the character over (the first gets close code 4103);
5. with `--hmr`: after a backend hot reload the room, the world and identities are still there.

Use it after changing the room, the network config, `createPlayer`/`onPlayerOnline`, or anything about sessions.

## Load and latency: `gaime load`

```sh
npm run load -- <game> --bots 50 --seconds 30      # from the repo root, uses the game's input template
cd games/<game> && npx gaime load --bots 20 --rate 30 --chat 0.5 --input '{"mx":"$rand","fire":"$bool"}'
GAIME_LATENCY_MS=100 npm run dev -- <game>          # simulate a server round trip for everyone
```

Bots are **ephemeral**: they join with `gaime-ephemeral`, send random inputs from the template, and are removed from the world when they leave. Template values: `$rand` (−1..1), `$rand*N`, `$bool`, `$int(a,b)`, `$pick(a|b|c)`; each game's `package.json` has a `load` script with a matching template.

The report (JSON) — what to look at:

| Field | Meaning | Healthy |
| --- | --- | --- |
| `rttMs.p50/p95/p99` | request → response round trip | ≈ network RTT + ≤ 1 tick |
| `perBot.messagesInPerSecond` | patches per client per second | ≈ tickRate / publishEvery |
| `perBot.approxKBInPerSecond` | download per client | a few KB/s; > 50 KB/s is heavy |
| `server.tickMsMax` | slowest simulation tick | below 1000 / tickRate (33 ms at 30 Hz); a warning is printed otherwise |
| `server.publishMsMax` | slowest projection + diff + send | a few ms |
| `server.patchBytesMax` | biggest patch | < 10 KB; big ones mean an unlisted big dictionary or too many effects |
| `server.eventLoopP99Max` | Node event loop delay | < 20 ms |

While it runs, `/gaime/stats` tells you where the tick goes: `parts` lists the most expensive systems, handlers and commands by module (`msPerSecond`), `droppedMs` > 0 means the server fell behind the fixed-step clock, and `engine.droppedEvents` counts client events cut by the 256-per-tick cap:

```sh
curl -s localhost:5173/gaime/stats | jq '{tickMs, droppedMs, engine, parts: .parts[:5]}'
```

What to do about bad numbers: [PROTOCOL.md](PROTOCOL.md) (network config, publish rate, precision) and the `gaime-networking` skill; heavy computation → workers ([SERVER.md](SERVER.md#heavy-processing-workers)).

Do not load-test a public game with real players on it without warning them.

## Browser checklist

Open `http://localhost:5173` (`npm run dev -- <game>`):

- [ ] A second player: another tab with `?player=2` (a separate identity).
- [ ] Bad network: `?lag=150&jitter=40&loss=5` — movement still feels right (prediction, interpolation).
- [ ] F3: ping, patch rate and size look sane.
- [ ] Hot reload: edit a client file and a server file while playing — no page reload, one canvas, no duplicated sounds or listeners, the world is intact.
- [ ] `/bot` (as host) — the game is playable against bots.
- [ ] Reload the page — you are back as the same character.
- [ ] A phone or the devtools device toolbar — touch controls show up and work.
- [ ] The console has no errors.

## Framework tests

`packages/core/tests`: the engine (`engine.test.ts`: the timer heap, event order, modifiers, systems and phases, module commands, isolation, event storms, forwarded events, `testGame`/`testContext`), delta sync and input gate (`net.test.ts`), registry validation, the kit, worker pools, the client's room lookup (`client.test.ts`), model loading (`three.test.ts`), and a real server with WebSocket clients (`server.test.ts`: smoke, error pause, chat/RPC/events/jobs, per-player views, bots, unique names, admin API, corrupt checkpoints). `packages/host/tests`: tree sync, dependency linking, the load-test templates, control acknowledgements, rollback and `status --json` (`supervisor.test.mjs`), flag parsing and numeric settings (`util.test.mjs`). Changes to the framework need a test next to the change; see the `gaime-engine` skill.

## CI

`.github/workflows/check.yml` runs `npm ci`, `npm run check`, `npm test` and `npm run build` on every push and pull request. The supervisor on the server additionally runs the gates from `GAIME_GATES` (default: typecheck) before deploying a commit.
