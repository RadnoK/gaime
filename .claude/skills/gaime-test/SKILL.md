---
name: gaime-test
description: Test gaime games and the framework — logic tests with testGame (the real engine without a network) and testContext, bot-vs-bot rounds, end-to-end smoke tests with real WebSocket clients, hot-reload checks, load/latency tests, and pre-push verification. Use before pushing any change and whenever the user asks to test or debug game behaviour.
---

# Testing gaime games

## Before every push

```sh
npm run check                  # typecheck all packages and games (the server's deploy gate)
npm test                       # vitest: framework + all games
```

Faster loops: `npx vitest run games/<game>`, `npx tsc --noEmit -p games/<game>`.

## Logic tests (most value per minute)

`games/<game>/tests/*.test.ts` with **`testGame`** — the same `Engine` the server runs (fixed-step clock, timers, events, systems, modifiers, module handlers and commands, bots, jobs), driven by the test:

```ts
import { testGame } from '@gaime/core/server';
import { game } from '../src/server/game';

const setup = () => testGame(game, { seed: 1 });

test('collecting a pickup scores', () => {
  const t = setup();
  const ada = t.join('Ada');                          // first human = host
  t.input(ada, { mx: 1, mz: 0 });                     // held until changed
  t.run(3);                                           // 3 s of game time (or t.tick(n))
  expect(t.triggeredOf('pickup.collected').length).toBeGreaterThan(0);
  expect(t.command(ada, { type: 'reset-scores' })).toBeUndefined();
});
```

- Inspect: `t.world`, `t.player(id)`, `t.triggered` / `t.triggeredOf(event)` (bus events in order), `t.events` (client events: `ctx.emit` + forwarded), `t.notices`, `t.feed()`, `t.ctx.timeLeft(key)`, `t.ctx.timers(prefix)`.
- Drive: `t.join`, `t.leave`, `t.remove`, `t.addBot()`, `t.input`, `t.tick`, `t.run(seconds, until?)`, `t.command`, `t.chat`, `t.request`, `await t.flushJobs()`; run `Sim` helpers like a system would with `t.act(sim => sim.spawnPickup('coin', t.player(ada)))` (its events are handled right after); `t.sim()` is for reading.
- **Strict by default**: an exception in a module or in game code throws out of `t.tick`/`t.run`/`t.command`, so a broken module fails the test. `testGame(game, { strict: false })` tests isolation itself: `t.disabled`, `t.world.pause`.
- Saves: `testGame(game, { world: oldShapedWorld })` hydrates and migrates it like a checkpoint.
- Always seed randomness: `{ seed: n }` seeds the world's generator (`world.rng`) and keeps the run replayable; `{ random: seeded(n) }` also works but cannot be replayed.
- Test: a full round/wave (`t.run(seconds, () => done)`), events and timers (`triggeredOf`, `timeLeft`), commands refusing invalid use (not host, not your turn, no ammo), every module loads (`registry.lists.<kind>.length`) and does what it promises, removed modules are cleaned by `prepareWorld`, old saves load.
- Games with a `bot` brain: `t.addBot(); t.addBot(); t.run(600, () => someoneWon(t.world))` — an excellent end-to-end rule test.
- `t.admin(name, ...args)` runs an operator command; `testGame(game, { budget: true })` turns module time budgets on (off by default — they measure wall-clock time).

## Determinism: record and replay

Every game keeps one test that records a session and replays it — it catches `Math.random()`, `Date.now()` and module-level state the day they are introduced, and it proves live recordings (`gaime replay`) will be usable:

```ts
import { replay, testGame } from '@gaime/core/server';

test('a recorded session replays exactly', () => {
  const t = testGame(game, { seed: 5, record: true });
  const ada = t.join('Ada'); t.addBot();
  for (let s = 0; s < 30; s++) { t.input(ada, { mx: Math.sin(s), mz: 0 }); t.run(1); }   // Math.sin is fine: it is the test's input
  t.command(ada, { type: 'start' });                                          // a command of your game
  const result = replay(game, JSON.parse(JSON.stringify(t.recording())));   // a JSON round trip, like a saved file
  expect(result.diverged).toBeUndefined();
  expect(result.verified).toBeGreaterThan(0);
  expect(JSON.stringify(result.world)).toBe(JSON.stringify(t.world));
});
```

- Drive the recorded run only through `join`, `input`, `command`, `chat`, `request`, `admin`, `addBot`, `leave`, `remove` — `t.act(...)` runs outside the recorder and marks the recording incomplete.
- To test that a replay can start mid-game (the oldest segments dropped), shorten the window: `testGame({ ...game, record: { minutes: 0.05 } }, { seed, record: true })` — see `games/bumper/tests`.
- A failing replay: `result.diverged.tick` is the first check (every 150 ticks) that differs — bisect with `replay(game, recording, { onTick })`; causes in `docs/TROUBLESHOOTING.md#a-replay-diverges`.
- A recording saved by the server (`npx gaime replay`, or automatically after an error) replays the same way — make it a regression test once the bug is fixed.

`testContext(world, { random, command })` is for unit tests of single functions without a game: it returns `ctx`, `notices`, `events`, `triggered` (bus events are recorded, no handlers run), `advance(seconds)` (fires due timers into `triggered`), `removed`, `flushJobs()`. Anything involving handlers, systems or modules belongs in `testGame`.

## End-to-end against a running server

```sh
npm run dev -- <game>                          # terminal 1
cd games/<game> && npx gaime smoke             # real clients: snapshot, patches, chat, drop+reconnect, tab takeover
npx gaime smoke --hmr                          # also touches the server entry: room, world and identities survive
npx gaime players | world <key> | admin …      # inspect and drive the live game
```

In the browser: second player `?player=2`, bad network `?lag=150&jitter=40&loss=5`, F3 stats. Edit a client file while playing — no page reload, one canvas.

## Load and latency

```sh
npm run load -- <game> --bots 50 --seconds 30        # uses the game's input template from package.json
```

Read `rttMs`, `perBot`, `server.tickMsMax` (< 33), `publishMsMax`, `patchBytesMax`, `eventLoopP99Max`. Meanwhile `curl -s localhost:5173/gaime/stats | jq '{droppedMs, engine, parts}'` names the systems/handlers/commands that cost the most and shows dropped time and dropped client events. Bots are `ephemeral` and disappear afterwards. Never run load tests against a public game with real players without asking.

## Framework tests

`packages/core/tests` (the engine in `engine.test.ts`, recordings and replays in `determinism.test.ts`, rooms and matchmaking in `rooms.test.ts`, delta sync, registry, kit, workers, a real server with WebSocket clients) and `packages/host/tests` (tree sync, dependency linking, commit filter). When changing the framework, run everything and add a test next to the code you changed.

## Debugging tips

- Write intermediate state to a file (`writeFileSync('/tmp/x.txt', …)`) inside a test when vitest swallows logs.
- A phase that lasts one tick (e.g. `ended` followed by an automatic rematch) is easy to miss in a loop — assert on counters (wins, round) instead.
- `/health` shows the loaded version, the last code error and `disabled` modules; `world.pause` holds the error message after an exception in game code.
- Print `t.feed()` and `t.triggered` when a test fails — they tell the story of the run.

## Reference

`docs/TESTING.md`, `docs/SIMULATION.md#determinism-and-replays`, `docs/reference/CONFIG.md#testgame-and-replay`, `docs/reference/CLI.md` (smoke, load, replay).
