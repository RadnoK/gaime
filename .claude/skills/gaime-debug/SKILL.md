---
name: gaime-debug
description: Diagnose a broken or misbehaving gaime game — paused with ⚠, server code failing to load, hot reload duplicating things, desync/rubber-banding, lag, lost saves, a push that does not go live. Use when something is wrong and the cause is not obvious yet, locally or on the server.
---

# Debugging a gaime game

Work from evidence: read the error first, reproduce it in a test second, fix third. `docs/TROUBLESHOOTING.md` has the full symptom table.

## 1. Collect evidence

```sh
curl -s localhost:5173/health | jq          # loaded version, last code error (or the public URL)
cd games/<game>
npx gaime status                            # supervisor: deploy history, failed commits, paused updates
npx gaime world pause                       # why the simulation is paused
npx gaime world players | jq 'map_values({name, online, x, z, hp})'
npx gaime players
```

Plus the dev server terminal (stack traces), the browser console, F3 in the game (ping, patches). On a Docker server: `docker compose logs --tail=200 game`.

## 2. Classify

| Evidence | Meaning | Go to |
| --- | --- | --- |
| `world.pause.reason === 'error'`, ⚠ in the feed | exception in `step`/hooks/bot/job result | stack trace → reproduce in a logic test |
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
const world = structuredClone(saved) as World;
const { ctx } = testContext(world, { random: seeded(1) });
prepareWorld(world, registry);
step(world, registry, {}, 1 / 30, ctx);        // throws the same error, now with a debugger and fast iteration
```

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
- `?player=2` — a second local identity.

## Reference

`docs/TROUBLESHOOTING.md`, `docs/TESTING.md`, `docs/reference/CLI.md`, `docs/DEPLOYMENT.md#troubleshooting`.
