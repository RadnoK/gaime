---
name: gaime-engine
description: Change the gaime framework itself — packages/core (networking, room, persistence, kit, client, three, ui, audio, vite plugin) or packages/host (supervisor, CLI) — without breaking the games that run on it. Use when a game needs something the framework does not offer, or when fixing framework bugs.
---

# Changing the framework

`packages/core` and `packages/host` are shared by every game in `games/`, and a push to `main` hot-reloads core code into running games. Prefer solving things in the game; change the engine when the need is general.

## Map

| Area | Files | Notes |
| --- | --- | --- |
| Types, delta sync, registry, protocol | `packages/core/src/shared/` | wire format changes → bump `PROTOCOL_VERSION`, keep old fields working |
| Room: sessions, reconnect, host, bots, chat, admin, jobs, checkpoints | `packages/core/src/server/room.ts`, `chat.ts`, `persistence.ts`, `runtime.ts` | express routes are registered once per process — read live state through `runtime()` |
| Game definition API | `packages/core/src/server/game.ts` | adding optional fields is safe; changing required ones breaks every game |
| Workers | `server/workers.ts`, `server/worker-bootstrap.mjs`, `worker/` | bootstrap is plain JS run by Node |
| Gameplay kit | `packages/core/src/kit/` | pure functions over plain data; no DOM, no Node APIs |
| Client | `client/` (GameClient, Controls, Scope), `three/`, `ui/` (+ `ui.css`), `audio/` | browser only |
| Vite plugin | `packages/core/src/vite/index.ts` | changes restart Vite on the server (not a hot reload) |
| Supervisor / CLI | `packages/host/` | plain Node ESM, no dependencies; changes need a supervisor restart on servers |

## Rules

1. **Backwards compatible by default**: new options optional with defaults; never rename exported symbols without keeping an alias; never change the checkpoint format without reading the old one (`format: 1`).
2. **No dependencies in `packages/host`** (it runs before `npm ci` on a fresh server). Core dependencies go to `packages/core/package.json`; every new dependency restarts all games on deploy.
3. **Hot-reload safety**: module-level state that must survive a reload goes to `globalThis[Symbol.for('gaime.<name>')]` (see `runtime.ts`, `metrics.ts`, `workers.ts`); anything else is recreated.
4. **The kit stays pure**: plain data in and out, deterministic given `random`, usable on server and client.
5. **English everywhere** (code, messages, docs).
6. **Every change gets a test** in `packages/core/tests` or `packages/host/tests`; the server test (`server.test.ts`) boots a real server with WebSocket clients — extend it for room/protocol changes.
7. **Update the docs** you affect: `docs/*.md` (API reference lives there), `AGENTS.md`, skills in `.claude/skills/` if the workflow changes.

## Verify

```sh
npm run check && npm test
npm run build                                          # all games still build
for g in blank starter duel; do (cd games/$g && GAIME_PORT=5190 npx vite >/dev/null 2>&1 & sleep 5; GAIME_PORT=5190 npx gaime smoke --hmr; pkill -f vite); done
```

For supervisor changes, test with a throwaway remote: clone to `/tmp`, create a bare repo, run `gaime host` in the clone with `GAIME_PORT=5190 GAIME_POLL_MS=1500`, push commits (good, broken, dependency change) and watch it hot-reload, revert and restart (see `packages/host/tests` for the helpers being tested).

## Pitfalls

- Name collisions with Colyseus `Room` members (`inputs`, `state`, `clock`, `clients`…) break silently at type level — check `node_modules/@colyseus/core/src/Room.ts`.
- Close codes 4000–4010 belong to Colyseus; gaime uses 4102/4103.
- Vite HMR boundaries need the literal `import.meta.hot.accept()` in the module.
- `import.meta.env.PROD` differs between dev (Vite), production builds and vitest — test all three for server code that depends on it.
