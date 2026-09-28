---
name: gaime-networking
description: Decide how data flows between client and server in a gaime game (input vs command vs request vs event vs world state), tune synchronisation (network config, publish rate, precision), and measure latency, bandwidth and load. Use for lag, jitter, bandwidth, "it feels laggy", many-player or high-packet-rate questions.
---

# Networking and performance

Reference: `docs/PROTOCOL.md`. The server is authoritative; clients get the world as a full snapshot then revisioned patches (~15/s).

## Choose the right channel

| Need | Use | Why |
| --- | --- | --- |
| Continuous control (move, aim, hold fire) | `net.input(x)` + `parseInput` | throttled, repeated while held, lease 400 ms (stops if the client vanishes) |
| A discrete action (cast, buy, ready) | `net.command({ type })` + `command()` or a module's `commands` | reliable, ordered, may return a refusal message |
| Ask the server something (ranking, shop) | `net.request(name, payload)` + `requests` | promise with a result or error, nothing stored |
| One-off feedback for a fact the game already triggers (a death, a pickup) | list the bus event in `network.events` → `net.onEvent('enemy.died', data => …)` (typed with `GameClient<World, Input, Command, Events>`) | no extra server code; payload = the bus payload; to everyone |
| Other one-off feedback (sound, shake, hit marker, to one player) | `ctx.emit(name, data, playerId?)` → `net.on('event')` | not stored, late joiners never see it |
| Anything everyone must see, now and after joining | the `World` | synchronised automatically, saved |
| Chat | `net.chat(text)`, `chat.commands` | rate-limited, slash commands |

Client events (both kinds) are **batched**: one `events` message per client per tick (protocol 3; older clients get one `event` message each), at most **256 per client per tick** — the rest are dropped and counted in `/gaime/stats` → `engine.droppedEvents`. Forward facts, not per-entity noise: one `wave.cleared` beats 200 `enemy.died` sounds in one tick.

## Tune synchronisation (`defineGame`)

```ts
network: {
  entities: ['players', 'enemies', 'projectiles'],   // every Record<id, T> that changes often
  streams: ['feed', 'effects'],                        // arrays of immutable { id } items
  shared: ['catalog'],                                 // replaced wholesale, never saved
  hidden: ['spawns'],                                  // server-only state (the engine's `schedule` is always hidden)
  precision: { hp: 1 },                                // round on the wire (default x/z/angle 0.01)
  events: ['enemy.died'],                              // bus events also sent to clients
},
tickRate: 30,          // simulation Hz
publishEvery: 2,       // patches at 15 Hz; 3 → 10 Hz for many clients
maxMessagesPerSecond: 90,
```

Checklist when bandwidth is high: big dictionaries listed in `entities`? Per-tick noise (timers, counters) in `hidden` or rounded? Arrays that grow (`effects`) pruned every tick? Large static data (maps) only rewritten when it really changes (assign a new array only then)?

## Make it feel good under latency

- Interpolate remote entities 100 ms in the past (`ServerClock` + `Interpolator`).
- Predict your own movement with the shared movement function, reconcile softly (snap only when far off).
- Local visual feedback immediately (muzzle flash, sound) — the authoritative result follows.
- Aim/look direction can be local while the server uses the value from `input`.

## Measure

```sh
# simulated bad network in the browser
http://localhost:5173/?lag=150&jitter=40&loss=5
# server-side delay for every client
GAIME_LATENCY_MS=120 npm run dev -- <game>
# F3 in the game: ping, patches/s, KB/s, inputs/s, resyncs, server tick/publish/patch, workers
# real bots: RTT p50/p99, messages & KB per bot, max tick/publish/patch, event-loop delay
npm run load -- <game> --bots 50 --seconds 30
npx gaime load --input '{"mx":"$rand","mz":"$rand","fire":"$bool"}' --rate 30 --chat 0.3   # inside games/<game>
```

Budgets: tick max < 33 ms (30 Hz), publish ms small, event loop p99 < 20 ms, patch bytes per client ideally < 2–4 KB.

If the tick is the problem, find the culprit first:

```sh
curl -s localhost:5173/gaime/stats | jq '{tickMs, droppedMs, engine, parts}'
```

- `parts`: the 15 most expensive systems (`<owner>/<id>`), handlers (`<owner> on <event>`) and commands (`<owner> command <type>`), in `msPerSecond` (share of every second spent there), `callsPerSecond` and `maxMs` (the worst single call — spikes). The owner is `game` or a module id, so you know whose code to fix.
- `droppedMs` > 0: the fixed-step clock could not catch up (limit 3 ticks) and simulated time was dropped — players saw slow motion.
- `engine`: `events` / `timers` fired since the last code load, `timersPending`, `deferredTimers` (ticks that hit the 5 000-timers limit), `droppedEvents` (client events over the per-client cap).

Fixes: `SpatialHash` for neighbour queries, `every` on systems for AI and spawners (think at 5 Hz, not 30), handlers that do less per event, workers for heavy work (`gaime-worker` skill).

## Pitfalls

- Sending game results from the client ("I hit X") — never; send intents.
- Using commands for continuous input (60 commands/s) — hits the message limit; use `input`.
- Storing per-client UI state in the world (menus open, hover) — keep it on the client.
- Client code with `?lag` disabled only — always test once with lag.
- Putting one-off sounds into the world — use events. (Short visual effects that should also appear for a client that joins mid-explosion belong in an `effects` stream with `addEffect`.)
- Forwarding a high-frequency event (per bullet, per tick) — it hits the 256 cap and costs bandwidth; forward summaries.

## Reference

`docs/PROTOCOL.md`, `docs/SERVER.md#per-player-views`, `docs/TESTING.md#load-and-latency-gaime-load`, `docs/reference/CONFIG.md` (NetworkConfig, tick and publish rates).
