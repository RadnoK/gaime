# Testing

Four layers, from fastest to most realistic. Run the first two before every push — the server runs the typecheck as a deploy gate anyway, and a failing push is reverted.

| Layer | Command | What it proves | Time |
| --- | --- | --- | --- |
| Types | `npm run check` | everything compiles (the deploy gate) | ~10 s |
| Logic | `npm test` / `npx vitest run games/<game>` | rules, modules, rounds, bots, saves | seconds |
| End to end | `npx gaime smoke [--hmr]` (in `games/<game>`) | real WebSocket clients: sync, commands, reconnect, takeover, hot reload | ~10 s |
| Load | `npm run load -- <game> --bots 50` | latency, bandwidth, tick cost under load | 20 s+ |

Plus the browser for everything visual (see [the checklist](#browser-checklist)).

## Logic tests

Game logic is plain functions over a plain-JSON world, so it runs in vitest without a server or network. Tests live in `games/<game>/tests/*.test.ts` and are picked up by the root `vitest.config.ts`.

### The setup every template uses

```ts
import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testContext } from '@gaime/core/server';
import { registry } from '../src/server/registry';
import { command, createPlayer, createWorld, prepareWorld, step } from '../src/server/simulation';
import type { Command, Input } from '../src/shared/types';

function setup() {
  const world = createWorld();
  const { ctx, notices, events, removed, flushJobs } = testContext(world, {
    random: seeded(1),                                                   // deterministic
    command: (id, c) => command(world, registry, id, c as Command, ctx), // routes ctx.command (used by bots)
  });
  world.players.a = createPlayer(world, 'a', 'Ada');
  world.hostId = 'a';
  prepareWorld(world, registry);
  const run = (seconds: number, inputs: () => Record<string, Input> = () => ({})) => {
    for (let t = 0; t < seconds; t += 1 / 30) { world.time += 1 / 30; step(world, registry, inputs(), 1 / 30, ctx); }
  };
  return { world, ctx, run, notices, events, removed, flushJobs };
}
```

### `testContext(world, options?)`

Returns a `GameContext` that behaves like the room's, without a room:

| Returned | Contents |
| --- | --- |
| `ctx` | pass to `step`, `command`, hooks; `ctx.log` writes to `world.feed` |
| `notices` | `{ playerId, text }[]` from `ctx.notify` |
| `events` | `{ name, data, playerId? }[]` from `ctx.emit` |
| `removed` | ids passed to `ctx.removePlayer` |
| `flushJobs()` | awaits `ctx.job` work and applies the results, like the next tick would |

| Option | Default | Use |
| --- | --- | --- |
| `random` | `Math.random` | always pass `seeded(n)` |
| `command` | ignored | route `ctx.command(id, command)` — needed when bots issue commands |

`ctx.addBot` throws in tests; make a bot with `createPlayer` and `player.data['gaime-bot'] = true`, then call your bot brain yourself.

### What to test

- **A full cycle**: a round, a wave, a match from lobby to result. Assert on counters (`wins`, `round`, `score`) rather than on phases that may last one tick.
- **Commands refuse invalid use**: not the host, not your turn, not enough gold, dead players. A returned string is the refusal message (`expect(command(...)).toMatch(/Not your turn/)`).
- **Modules**: every kind has definitions (`registry.lists.enemies.length > 0`), each definition's hooks do not throw, `prepareWorld` cleans up references to removed definitions.
- **Saves**: an old-shaped world survives `hydrate` + `migrate`:

  ```ts
  import { hydrate } from '@gaime/core';
  const old = { schema: 1, players: { a: { id: 'a', name: 'Ada', coins: 3 } } } as any;
  const world = game.migrate!(hydrate(old, createWorld(), createPlayer(createWorld(), 't', 't')));
  expect(world.players.a.gold).toBe(30);
  ```

- **Bots**: bot versus bot until someone wins is an end-to-end test of your rules, with no mocking:

  ```ts
  for (const id of ['a', 'b']) world.players[id].data['gaime-bot'] = true;
  const brains = () => Object.fromEntries(['a', 'b'].map(id => [id, game.bot!(world, id, ctx)]).filter(([, i]) => i));
  for (let i = 0; i < 1500 && world.players.a.wins + world.players.b.wins === 0; i++) run(1, brains);
  expect(world.players.a.wins + world.players.b.wins).toBe(1);
  ```

- **Jobs**: call the code that uses `ctx.job`, `await flushJobs()`, then assert the applied result. The job function itself runs inline in tests (workers only exist in a server process); test worker functions directly by importing them.
- **Kit usage**: pure functions — call them with plain objects.

Examples: `games/blank/tests`, `games/starter/tests` (waves, abilities, removed modules, jobs), `games/duel/tests` (seats, turns, bot vs bot).

### Running

```sh
npm test                                   # everything (framework + all games)
npx vitest run games/duel                  # one game
npx vitest run games/duel -t "two bots"    # one test
npx vitest games/duel                      # watch mode
```

Logs from inside the simulation (`ctx.log`) go to `world.feed`, not the console — print `world.feed.map(f => f.text)` when a test fails.

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

`packages/core/tests`: delta sync and input gate (`net.test.ts`), registry validation, the kit, worker pools, the client's room lookup (`client.test.ts`), model loading (`three.test.ts`), and a real server with WebSocket clients (`server.test.ts`: smoke, error pause, chat/RPC/events/jobs, per-player views, bots, unique names, admin API, corrupt checkpoints). `packages/host/tests`: tree sync, dependency linking, the load-test templates, control acknowledgements, rollback and `status --json` (`supervisor.test.mjs`), flag parsing and numeric settings (`util.test.mjs`). Changes to the framework need a test next to the change; see the `gaime-engine` skill.

## CI

`.github/workflows/check.yml` runs `npm ci`, `npm run check`, `npm test` and `npm run build` on every push and pull request. The supervisor on the server additionally runs the gates from `GAIME_GATES` (default: typecheck) before deploying a commit.
