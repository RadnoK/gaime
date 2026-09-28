---
name: gaime-debug
description: Diagnose a broken or misbehaving gaime game — paused with ⚠, a module switched off, an event storm, timers not firing, things happening in the wrong order, server code failing to load, hot reload duplicating things, desync/rubber-banding, lag, lost saves, a push that does not go live. Use when something is wrong and the cause is not obvious yet, locally or on the server.
---

# Debugging a gaime game

Work from evidence: read the error first, reproduce it in a test second, fix third. `docs/TROUBLESHOOTING.md` has the full symptom table.

## 1. Collect evidence

```sh
curl -s localhost:5173/health | jq          # loaded version, last code error, disabled modules (or the public URL)
curl -s localhost:5173/gaime/stats | jq '{tickMs, droppedMs, engine, parts}'   # where the tick goes
cd games/<game>
npx gaime status                            # supervisor: deploy history, failed commits, paused updates
npx gaime world pause                       # why the simulation is paused
npx gaime world schedule | jq .live         # pending timers: key → { at, event }; compare `at` with `npx gaime world time`
npx gaime world players | jq 'map_values({name, online, x, z, hp})'
npx gaime players
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
| `Failed to load server module`, supervisor "failed to load" | import-time error (registry validation, duplicate id, top-level code) | the message names the file |
| `failed … gate` | typecheck (or configured tests) failed | `npm run check` |
| Duplicate canvases/sounds after edits, page reloads on edit | client HMR hygiene | `gaime-client` skill |
| Rubber-banding, jitter, lag | prediction mismatch or bandwidth/tick budget | `gaime-networking` skill, `npm run load` |
| State reset / lost progress | checkpoint not written, schema change without migration, renamed game `name` | `gaime-mechanic` skill (saves) |

## 3. Reproduce in a test

Copy the relevant part of the live world into a logic test — the world is plain JSON:

```sh
npx gaime world > /tmp/world.json
```

```ts
import saved from '/tmp/world.json';
const t = testGame(game, { world: saved, random: seeded(1) });   // hydrated, migrated, prepared like a live load
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
- `?player=2` — a second local identity.

## Reference

`docs/TROUBLESHOOTING.md`, `docs/TESTING.md`, `docs/reference/CLI.md`, `docs/DEPLOYMENT.md#troubleshooting`.
