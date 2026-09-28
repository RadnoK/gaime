---
name: gaime-debug
description: Diagnose a broken or misbehaving gaime game — paused with ⚠, a module switched off, an event storm, timers not firing, things happening in the wrong order, server code failing to load, hot reload duplicating things, desync/rubber-banding, lag, a module throttled over its time budget, replaying a live bug from a flight recording (gaime replay) or a replay that diverges, lost saves, a push that does not go live. Use when something is wrong and the cause is not obvious yet, locally or on the server.
---

# Debugging a gaime game

Work from evidence: read the error first, reproduce it in a test second, fix third. `docs/TROUBLESHOOTING.md` has the full symptom table.

## 1. Collect evidence

```sh
curl -s localhost:5173/health | jq          # loaded version, last code error, disabled modules (or the public URL)
curl -s localhost:5173/gaime/stats | jq '{tickMs, droppedMs, engine, throttled, parts}'   # where the tick goes, throttled modules
cd games/<game>
npx gaime status                            # supervisor: deploy history, failed commits, paused updates
npx gaime world pause                       # why the simulation is paused
npx gaime world schedule | jq .live         # pending timers: key → { at, event }; compare `at` with `npx gaime world time`
npx gaime world players | jq 'map_values({name, online, x, z, hp})'
npx gaime players
npx gaime replay --list                     # flight recordings the server saved after errors
npx gaime replay "what went wrong"          # save the last minutes now, while the bug is fresh
npx gaime rooms                             # matches mode: which room (then --room <id|code> on every command)
```

Plus the dev server terminal (stack traces), the browser console, F3 in the game (ping, patches). On a Docker server: `docker compose logs --tail=200 game`.

## 2. Classify

| Evidence | Meaning | Go to |
| --- | --- | --- |
| `world.pause.reason === 'error'`, `⚠ Game code error` in the feed | exception in game code: `step`, the game's systems/handlers/modifiers, `bot`, `prepare`, a job result — or a definition hook called without `isolate` | stack trace → reproduce in a `testGame` test; wrap hooks in `sim.isolate(owner, …)` |
| `⚠ Module "<id>" was switched off`, `/health` → `disabled` | exception in that module's handler, modifier, system or isolated hook; the rest keeps running | server log `[gaime] module <id>`; reproduce with `testGame` (strict throws); push a fix — the next code load switches it back on |
| `Event storm: more than 50000 events at once (last: "<event>")` | a handler (re)triggers the event it handles, directly or in a chain | find the `on['<event>']` that triggers `<event>`; guard with state or trigger a different event |
| A timer never fires | paused world, wrong/typo event name (no handler), same key reused (replaced), cancelled by a too-broad prefix, `player:<id>:` key of a removed player, owning module switched off | `gaime world schedule`, `ctx.timeLeft(key)` in a test; keys with a terminating separator (`enemy:1:`) |
| Values computed in the wrong order / stale right after `trigger` | handlers run after the code that triggered the event; phases run `input` → `step` → `update` → `late`, game before modules | move the reading code to a later phase or into the handler; see `docs/TROUBLESHOOTING.md#things-happen-in-the-wrong-order` |
| Tick slow, slow motion, `droppedMs` > 0 | an expensive system/handler/command | `parts` in `/gaime/stats` names it (owner + id, `msPerSecond`, `maxMs`); `gaime-networking` skill |
| `⚡ Module "<id>" is over its time budget`, `/gaime/stats` → `throttled` | that module's systems + handlers cost more than its budget (default 20% of the tick); its systems now run every 2nd–8th tick (choppy), handlers still run | `parts` names the part; spatial index (`ctx.near`) instead of n², `every` on systems, workers; `docs/TROUBLESHOOTING.md#a-module-is-over-its-time-budget` |
| A replay reports `diverged` | non-determinism (`Math.random`, `Date.now`, module-level state, a resource without `save`/`load`) or different code than recorded | `docs/TROUBLESHOOTING.md#a-replay-diverges`; bisect with `onTick` |
| `recording.reason` ends with `(incomplete: …)` | the world was changed outside recorded entry points (`t.act`, `engine.outside`) or an entry was not serialisable | drive through inputs/commands/requests/admin; `docs/TROUBLESHOOTING.md#a-recording-is-incomplete` |
| `Failed to load server module`, supervisor "failed to load" | import-time error (registry validation, duplicate id, top-level code) | the message names the file |
| `failed … gate` | typecheck (or configured tests) failed | `npm run check` |
| Duplicate canvases/sounds after edits, page reloads on edit | client HMR hygiene | `gaime-client` skill |
| Rubber-banding, jitter, lag | prediction mismatch or bandwidth/tick budget | `gaime-networking` skill, `npm run load` |
| State reset / lost progress | checkpoint not written, schema change without migration, renamed game `name` | `gaime-mechanic` skill (saves) |

## 3. Reproduce in a test

**Best: replay the recording.** The server records the last minutes of every room (inputs, commands, joins, operator actions, worker results, with world snapshots) and saves them to `<data>/replays/` when the game pauses on an error or a module is switched off — or when you run `npx gaime replay`. Copy the file into the repo (not committed if it holds real player data) and replay it with the **same code version** (`recording.version`):

```ts
import { readFileSync } from 'node:fs';
import { replay } from '@gaime/core/server';
const recording = JSON.parse(readFileSync('/tmp/replay.json', 'utf8'));
const result = replay(game, recording, {
  until: 18_500,                                           // stop here (a tick)
  onTick: (world, tick) => { if (tick > 18_400) console.log(tick, world.players); },
});
expect(result.diverged).toBeUndefined();                   // a divergence = non-deterministic code or different code
```

The replay runs the exact ticks that happened live, so the same error happens at the same tick (its stack is logged; `result.world.pause` / `result.engine.disabledModules`). Physics games replay exactly too (Rapier's state is in the recording).

**Otherwise:** copy the relevant part of the live world into a logic test — the world is plain JSON:

```sh
npx gaime world > /tmp/world.json
```

```ts
import saved from '/tmp/world.json';
const t = testGame(game, { world: saved, seed: 1 });             // hydrated, migrated, prepared like a live load
t.tick();                                                        // strict: throws the same error, with a stack and fast iteration
```

The dump includes pending timers (`schedule`), so timer-driven bugs replay too. `strict: false` shows what the live server did instead (`t.disabled`, `t.world.pause`).

(Only for local debugging — do not commit real player data.)

## 4. Fix safely

- Fix the cause, then make the code robust to the state that is already live (e.g. entities of a kind that no longer exists, fields missing on old entities) — the running world will not reset itself.
- Add the reproduction as a regression test.
- `npm run check && npm test`, push. A paused game resumes on the next code load; confirm with `/health` and `gaime status`.
- If players are blocked right now and the fix takes time: `gaime rollback` on the server (live mode keeps the world), then `gaime resume` after the fix is pushed.

## Tools worth knowing

- `?lag=150&jitter=40&loss=5` in the browser, `GAIME_LATENCY_MS=100` for the server — reproduce network problems locally.
- `npx gaime smoke [--hmr]` — is it the room/network or the game?
- `npx gaime game pause|resume|save`, `npx gaime admin <command>` — freeze the live game while you look, run the game's own admin commands.
- `t.triggered` in a `testGame` test — every bus event in dispatch order: the quickest way to see what happened and in which order.
- `testGame(game, { budget: true })` — reproduce module throttling in a test (budgets are off in tests by default).
- `?player=2` — a second local identity.

## Reference

`docs/TROUBLESHOOTING.md`, `docs/SIMULATION.md#determinism-and-replays`, `docs/TESTING.md`, `docs/reference/CLI.md` (`gaime replay`), `docs/DEPLOYMENT.md#troubleshooting`.
