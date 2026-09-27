---
name: gaime-test
description: Test gaime games and the framework — logic tests with testContext, bot-vs-bot rounds, end-to-end smoke tests with real WebSocket clients, hot-reload checks, load/latency tests, and pre-push verification. Use before pushing any change and whenever the user asks to test or debug game behaviour.
---

# Testing gaime games

## Before every push

```sh
npm run check                  # typecheck all packages and games (the server's deploy gate)
npm test                       # vitest: framework + all games
```

Faster loops: `npx vitest run games/<game>`, `npx tsc --noEmit -p games/<game>`.

## Logic tests (most value per minute)

`games/<game>/tests/*.test.ts`:

```ts
import { seeded } from '@gaime/core';
import { testContext } from '@gaime/core/server';
import { registry } from '../src/server/registry';
import { command, createPlayer, createWorld, prepareWorld, step } from '../src/server/simulation';

function setup() {
  const world = createWorld();
  const { ctx, notices, events, flushJobs } = testContext(world, { random: seeded(1) });
  world.players.a = createPlayer(world, 'a', 'Ada');
  world.hostId = 'a';
  prepareWorld(world, registry);
  const run = (seconds: number, inputs = {}) => {
    for (let t = 0; t < seconds; t += 1 / 30) { world.time += 1 / 30; step(world, registry, inputs, 1 / 30, ctx); }
  };
  return { world, ctx, run, notices, events, flushJobs };
}
```

- `testContext` collects `notices`, `events`, `removed`; `flushJobs()` applies `ctx.job` results; pass `command` to route `ctx.command` (bots) to your `command()`.
- Always seed randomness; advance `world.time` yourself.
- Test: a full round/wave, commands refusing invalid use (not host, not your turn, no ammo), every module loads (`registry.lists.<kind>.length`), removed modules are cleaned by `prepareWorld`, saves: an old-shaped world goes through `hydrate`/`migrate`.
- Games with a `bot` brain: run bot vs bot until someone wins — an excellent end-to-end rule test (see `games/duel/tests`).

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

Read `rttMs`, `perBot`, `server.tickMsMax` (< 33), `publishMsMax`, `patchBytesMax`, `eventLoopP99Max`. Bots are `ephemeral` and disappear afterwards. Never run load tests against a public game with real players without asking.

## Framework tests

`packages/core/tests` (delta sync, registry, kit, workers, a real server with WebSocket clients) and `packages/host/tests` (tree sync, dependency linking, commit filter). When changing the framework, run everything and add a test next to the code you changed.

## Debugging tips

- Write intermediate state to a file (`writeFileSync('/tmp/x.txt', …)`) inside a test when vitest swallows logs.
- A phase that lasts one tick (e.g. `ended` followed by an automatic rematch) is easy to miss in a loop — assert on counters (wins, round) instead.
- `/health` shows the loaded version and the last code error; `world.pause` holds the error message after a simulation exception.

## Reference

`docs/TESTING.md`, `docs/reference/CLI.md` (smoke, load).
