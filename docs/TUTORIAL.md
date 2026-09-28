# Tutorial: build "Tag" from the blank template

In this tutorial you turn `games/blank` into a multiplayer game of tag. One player is "it". Everyone else earns a point per second. Touching someone passes "it" on, and the new "it" has to stand still for two seconds before tagging anyone. Speed-boost pickups come from a module. You work in every layer of a gaime game: world state, events, systems, a modifier, a module, client prediction, HUD, sound, a bot and a test.

The tutorial also shows where each piece belongs in the engine's simulation model ([SIMULATION.md](SIMULATION.md)):

| Part of Tag | Mechanism | Where |
| --- | --- | --- |
| who is "it" | world state (`world.it`) | `src/shared/types.ts` |
| "X is it!", "X tagged Y!" | **events** `it.chosen`, `tag.passed` + `on` handlers | `types.ts`, `game.ts` |
| picking "it", detecting touches | a **system** that runs every tick | `simulation.ts` |
| a point per second | a **system** with `every: 1` | `simulation.ts` |
| points per second, adjustable by modules | a **modifier** `tag.points` | `simulation.ts` |
| the 2-second freeze of a new "it" | kit **`status`** in `player.data` | `rules.ts` |
| "it" disconnects: pass "it" on after 5 s, unless they come back | **engine events** `player.offline` / `player.online` + a keyed **timer** | `simulation.ts`, `game.ts` |
| speed boosts | a **module** (pickup + `status`) | `src/features/boost/` |
| the tag sound | the event forwarded via **`network.events`** | `game.ts`, `main.ts` |

We wrote and ran every snippet in steps 0–9 exactly as shown: typecheck, tests, the smoke test, and the browser with bots. The ideas at the end are sketches.

## 0. Create the game

```sh
npm run new-game -- tag --title "Tag"
npm install
npm run dev -- tag              # http://localhost:5173 — keep it running, everything hot-reloads
```

`games/tag` is now a copy of Blank, where players walk around a square field and collect coins. Open it in two tabs (add `?player=2` to the second tab's URL) to see two players. Read `src/server/game.ts` first. Its comment describes the order of a tick.

## 1. World state and events

`src/shared/types.ts`: add a field to `World`:

```ts
export interface World extends BaseWorld<Player> {
  pickups: Record<string, Pickup>;
  /** Id of the player who is "it", or null while nobody is. */
  it: string | null;
  /** Rebuilt from the registry on load; never saved. */
  catalog: CatalogEntry[];
}
```

In the same file, add two events to `Events` and a modifier to `Modifiers`:

```ts
export type Events = {
  // … the three pickup events stay …
  /** Somebody became "it" without being tagged (the game started, or "it" left). */
  'it.chosen': { playerId: string };
  /** `from` touched `to`, so `to` is "it" now. */
  'tag.passed': { from: string; to: string };
  /** "It" has been offline for RULES.awayGrace seconds (a timer). */
  'it.away': { playerId: string };
};

export type Modifiers = {
  /** Points a pickup is worth for this player. */
  'pickup.points': { playerId: string; kind: string };
  /** Points a runner (anyone who is not "it") earns per second. */
  'tag.points': { playerId: string };
};
```

`src/server/simulation.ts`: give the new field its default in `createWorld()`:

```ts
export function createWorld(): World {
  return { ...baseWorld(SCHEMA), pickups: {}, it: null, catalog: [] };
}
```

Notes on this step:

- **Events are the game's vocabulary.** Other people's modules will react to `tag.passed` (for example, a bounty for tagging the leader) without touching your code, so declare events in `types.ts`, where module authors look. The names are facts in the past tense, and the payloads are plain JSON ids.
- **Declaring `Modifiers` makes names checked.** Blank passes both maps to the types (`Feature = FeatureModule<Kinds, Sim, Events, Modifiers>`, and `defineGame<World, Input, Sim, Events, Modifiers>` in step 4). A misspelled event or modifier name in a module is then a type error. Events a module keeps to itself are named `<module>:<event>` and need no declaration. Tag does not need any.
- **No migration needed.** On hot reload and when an old checkpoint loads, the engine fills missing fields from `createWorld()`. A running game gets `it: null` and keeps going. Changing the *meaning* of an existing field would need `SCHEMA` + `migrate()`.

## 2. Rules shared by server and client

Replace `src/shared/rules.ts`:

```ts
import { clampToRect, moveTopDown, status } from '@gaime/core/kit';
import type { Input, Player, World } from './types';

export const RULES = {
  /** The playing field is a square from -size/2 to +size/2 on x and z. */
  size: 40,
  speed: 8,
  playerRadius: 0.5,
  pickupRadius: 0.6,
  maxPickups: 4,
  spawnEvery: 3,
  /** Seconds a pickup stays before it disappears. */
  pickupLife: 20,
  /** Seconds a new "it" stands still and cannot tag: a head start for the runners, no instant tag-backs. */
  tagCooldown: 2,
  /** Points per second for everyone who is not "it" (before `tag.points` modifiers). */
  pointsPerSecond: 1,
  /** "It" is a little faster, or nobody would ever get caught. */
  itSpeedBonus: 1.1,
  /** Seconds an offline "it" has to come back before "it" passes on. */
  awayGrace: 5,
};

/** Status effects (kit `status`) in `player.data` that the rules read. Modules apply them. */
export const STATUS = {
  /** Speed multiplier: `status.apply(player.data, STATUS.speed, world.time, seconds, 1.6)`. */
  speed: 'speed',
  /** The new "it" stands still and cannot tag anyone yet. */
  tagCooldown: 'tag-cooldown',
} as const;

export const FIELD = { x: -RULES.size / 2, z: -RULES.size / 2, width: RULES.size, depth: RULES.size };

/** A player's current speed. Shared: the server moves with it, the client predicts with it. */
export function speedOf(world: World, player: Player) {
  const it = world.it === player.id;
  if (it && status.active(player.data, STATUS.tagCooldown, world.time)) return 0;
  const boost = status.value(player.data, STATUS.speed, world.time, 1);
  return RULES.speed * boost * (it ? RULES.itSpeedBonus : 1);
}

/** Whether this player is "it" and past the cooldown (the server tags with it, the client draws the ring with it). */
export function canTag(world: World, player: Player) {
  return world.it === player.id && !status.active(player.data, STATUS.tagCooldown, world.time);
}

/** Shared by the server (authority) and the client (prediction). */
export function movePlayer(player: { x: number; z: number }, input: Input, dt: number, speed = RULES.speed) {
  moveTopDown(player, input, speed, dt);
  clampToRect(player, FIELD, RULES.playerRadius);
}
```

Why the code is shaped this way:

- **The cooldown lives in `player.data`, not in a timer.** [SIMULATION.md](SIMULATION.md#where-things-go) says that a duration you *read on demand* (every tick: "may 'it' tag yet? may 'it' move?") goes into kit `status`/`cooldown` in `data`. A timer (`ctx.after(2, 'tag.ready', …, { key })`) is for something that must *happen* when the time is up. Nothing happens when the freeze ends; "it" can simply move and tag again. Nothing needs to be cancelled when "it" leaves, and because `player.data` is synced, the client can draw the cooldown (step 6) without extra messages. Both helpers store plain keys that survive hot reloads and checkpoints.
- **Why `status` and not `cooldown`:** `cooldown.start(player.data, 'tag', time, 2)` / `cooldown.ready(…)` would work just as well for "may tag again". But the freeze is an *effect on the player*: it also stops movement. It is the same kind of thing as the boost's `speed` status, read the same way by `speedOf` on the server and the client. Keeping both under `STATUS` makes that contract one list.
- **Speed is a shared function, not a modifier.** It is tempting to write `ctx.modify('player.speed', …)` and let modules adjust it. But modifiers run **only on the server**. The client predicts your own movement every frame with `movePlayer`, and it cannot run server modifiers. It would move you at the wrong speed, and the server correction would pull you back (rubber-banding). So everything that affects movement is computed in shared code from world data that the client receives. Modules influence speed through data (`status.apply(player.data, STATUS.speed, …)`), and `STATUS` documents the contract. Use modifiers for values only the server needs, like the points in step 3.
- The client's copy of `world.time` lags the server by a few frames, so near the end of a boost the prediction may be a few frames off. The client's small correction in `scene.ts` hides that.

## 3. The systems

`src/server/simulation.ts`: replace the kit and rules imports with these two lines, and move players with their current speed:

```ts
import { circlesOverlap, freeColor, pick, range, status, weighted } from '@gaime/core/kit';
import { canTag, movePlayer, RULES, speedOf, STATUS } from '../shared/rules';

// in step(), the movement line becomes:
    if (player.online && input) movePlayer(player, input, dt, speedOf(world, player));
```

Add two systems and a helper after `spawn()`:

```ts
/** System (every tick): make someone "it" when nobody is, and pass "it" on when "it" touches a runner. */
export function tag(sim: Sim) {
  const { world } = sim;
  const online = Object.values(world.players).filter(player => player.online);
  const it = world.it ? world.players[world.it] : undefined;
  if (!it) {
    // Nobody is "it" yet, or "it" was removed from the game.
    const next = pick(sim.random, online);
    world.it = next?.id ?? null;
    if (next) {
      status.apply(next.data, STATUS.tagCooldown, world.time, RULES.tagCooldown);
      sim.trigger('it.chosen', { playerId: next.id });
    }
    return;
  }
  if (!it.online || !canTag(world, it)) return;
  const caught = online.find(player => player.id !== it.id && circlesOverlap(it, RULES.playerRadius, player, RULES.playerRadius));
  if (!caught) return;
  // The facts change here, at once; reactions (feed, sound, modules) run from the event.
  world.it = caught.id;
  status.apply(caught.data, STATUS.tagCooldown, world.time, RULES.tagCooldown);
  sim.trigger('tag.passed', { from: it.id, to: caught.id });
}

/** System (every second): every online runner earns points; modules may change the amount (`tag.points`). */
export function score(sim: Sim) {
  const { world } = sim;
  if (!world.it) return;
  for (const player of Object.values(world.players)) {
    if (!player.online || player.id === world.it) continue;
    player.score += sim.modify('tag.points', RULES.pointsPerSecond, { playerId: player.id });
  }
}

/** On 'player.offline' / 'player.online': while "it" is away, pass "it" on after RULES.awayGrace s. */
export function watchIt(sim: Sim) {
  const it = sim.world.it ? sim.world.players[sim.world.it] : undefined;
  // Keyed by the player: scheduling again replaces the timer, removing the player cancels it.
  if (it && !it.online) sim.after(RULES.awayGrace, 'it.away', { playerId: it.id }, { key: `player:${it.id}:away` });
}
```

Notes on this step:

- **`tag` runs every tick** because touches are continuous. It also repairs itself: when nobody is "it" (a new game) or "it" was removed from the world, the next tick picks someone, whatever the reason.
- **An offline "it" is not replaced by the system.** An earlier draft of this step used `if (!it?.online)`, and it had a bug that only showed in the browser. During a server hot reload, a deploy or a restart, the room marks *every* player offline for a moment, without events, until their clients reconnect. Any tick in that gap, with a bot online, picked a new "it", so every code change shuffled "it". Now a real disconnect is handled by `watchIt`, which step 4 connects to the engine events: the engine triggers `player.offline`, and a timer gives "it" `RULES.awayGrace` seconds to come back. This is the "something later, once" case from SIMULATION.md, so it is a timer: when it fires, something must happen. The timer is also scheduled on `player.online`, when anyone reconnects. That covers a restart after which "it" never comes back, because no `player.offline` event is triggered for them then.
- **The timer key starts with `player:<id>:`**, so the engine cancels it by itself when that player is removed. Scheduling it again with the same key replaces it, so reconnect storms do not pile up timers. When it fires, the handler checks again ("still 'it', still offline?"), so a player who came back in time is not affected.
- **Facts in the system, reactions in handlers.** The system changes `world.it` right away, so later code in the same tick sees the new "it". Then it *triggers* `tag.passed`. The feed message, the sound and anything a module wants to do happen in handlers. Handlers run after the system finishes, in the same tick, so they never disturb its loop.
- **`score` gives whole points once per second (`every: 1`)** instead of `pointsPerSecond * dt` every tick. With whole numbers you don't need `Math.floor` in the UI or the tests. It also costs less bandwidth: a score that changes on every tick puts every player's score into every patch (15 per second), and one that changes once per second puts it into one patch per second. The price is coarseness: a runner who becomes "it" 0.9 s into a second gets nothing for that second. That is fine for a party game. If you need exact time (a race timer), accumulate `dt` per tick. Periodic systems are **staggered** by the engine, so the first run lands somewhere within the first second. Tests should allow for that (step 8).
- **`sim.modify('tag.points', …)`** lets any module change the points (double points for the last runner standing, a "golden" pickup) without editing this function. This value is server-only, so a modifier fits here, unlike speed in step 2.
- Randomness comes from `sim.random` and time from `world.time`, and `testGame` controls both. Never use `Math.random()` or `Date.now()` in the simulation.

## 4. Wire it into the game

Replace `src/server/game.ts`:

```ts
import { clamp } from '@gaime/core';
import { defineGame } from '@gaime/core/server';
import type { Command, Events, Input, Modifiers, Sim, World } from '../shared/types';
import { RULES } from '../shared/rules';
import { registry } from './registry';
import { botInput, collect, command, createPlayer, createWorld, makeSim, prepareWorld, score, spawn, step, tag, watchIt } from './simulation';

/**
 * How a tick runs (the engine does this, in this order):
 *   timers → `step` (inputs) → systems (`collect`, `tag`, then `spawn` and `score` when due, then module systems)
 * and every event triggered along the way reaches the `on` handlers — the game's first, then the modules'.
 */
export const game = defineGame<World, Input, Sim, Events, Modifiers>({
  name: 'tag',
  network: {
    entities: ['players', 'pickups'],
    shared: ['catalog'],
    // Bus events clients also receive (the client plays sounds).
    events: ['pickup.collected', 'tag.passed'],
  },
  features: registry,
  sim: (ctx, dt) => makeSim(registry, ctx, dt),
  createWorld,
  prepare: world => prepareWorld(world, registry),
  createPlayer: (world, id, name, ctx) => createPlayer(world, id, name, ctx.random),
  parseInput(raw) {
    const input = raw as Partial<Input> | null;
    if (!input || !Number.isFinite(input.mx) || !Number.isFinite(input.mz)) return undefined;
    return { mx: clamp(input.mx!, -1, 1), mz: clamp(input.mz!, -1, 1) };
  },
  step,
  systems: [
    { id: 'collect', run: sim => collect(sim, registry) },
    { id: 'tag', run: tag },
    { id: 'spawn', every: RULES.spawnEvery, run: spawn },
    { id: 'score', every: 1, run: score },
  ],
  on: {
    // Scoring is a reaction to the event, so modules can react to the same event too.
    'pickup.collected': ({ playerId, points }, sim) => {
      const player = sim.world.players[playerId];
      if (player) player.score += points;
    },
    'pickup.expired': ({ pickup }, sim) => { delete sim.world.pickups[pickup]; },
    'it.chosen': ({ playerId }, sim) => {
      const player = sim.world.players[playerId];
      if (player) sim.log(`${player.name} is it!`);
    },
    'tag.passed': ({ from, to }, sim) => {
      const tagger = sim.world.players[from];
      const tagged = sim.world.players[to];
      if (tagger && tagged) sim.log(`${tagger.name} tagged ${tagged.name}!`);
    },
    // Engine events: a dropped "it" gets RULES.awayGrace s to come back.
    'player.offline': (_, sim) => watchIt(sim),
    'player.online': (_, sim) => watchIt(sim),
    'it.away': ({ playerId }, sim) => {
      // Still gone? Then nobody is "it", and the tag system picks someone on the next tick.
      if (sim.world.it === playerId && !sim.world.players[playerId]?.online) sim.world.it = null;
    },
  },
  command: (world, playerId, payload, ctx) => command(world, playerId, payload as Command, ctx),
  bot: botInput,
});
```

The new parts are the `Modifiers` type argument, two systems, the handlers and one entry in `network.events`:

- The **system ids** (`tag`, `score`) show up in `/gaime/stats` → `parts` with their cost per second. That is the first place to look if the tick gets slow.
- The **handlers check that the players still exist**. Payloads carry ids, and by the time a handler runs the player may already be gone.
- **`player.offline` and `player.online` are engine events.** The engine triggers them on every game's bus (with `player.joined` and `player.removed`), so the game and any module can react to players coming and going without hooks. Their payload is `{ player }`, the player's id.
- **`network.events: ['tag.passed']`** forwards that bus event to every client as an `event` message (batched per tick) for sounds and effects. The state itself (`world.it`) reaches clients through the normal world patches. Never rely on an event for state, because a client that joins later never sees it.
- `sim.log` writes to the feed, which everyone sees and which is saved with the world.

Save the file. The server hot-reloads, the room keeps running, and on the next tick the feed shows "… is it!".

## 5. A module: speed boost

Content that other people might want to add lives in modules, and Blank's module kind is `pickups`. Coins no longer make sense in Tag, so delete Blank's example modules:

```sh
rm -r games/tag/src/features/coins games/tag/src/features/combo
```

Create `src/features/boost/server.ts`:

```ts
import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';
import { STATUS } from '../../shared/rules';

export default {
  author: 'tutorial',
  description: 'Boost: a pickup that makes you 60% faster for 3 seconds.',
  pickups: [{
    id: 'boost',
    name: 'Boost',
    description: '60% faster for 3 s.',
    value: 0,
    weight: 1,
    visual: { shape: 'cone', color: '#7dff9b', emissive: '#2a8a4a', scale: 0.7, lift: 0.3 },
    onPickup(sim, player) {
      status.apply(player.data, STATUS.speed, sim.world.time, 3, 1.6);
    },
  }],
} satisfies Feature;
```

- You register nothing. The registry globs `src/features/*/server.ts`, and the dev server picks up the new directory. On the reload, `prepareWorld` removes coins and gems that were lying on the field, because their modules are gone. Green cones start spawning.
- `onPickup` receives the game's `Sim`, and the game calls it through `sim.isolate(owner, …)` (see `collect()`). If this hook throws on the live server, only the `boost` module is switched off (a ⚠ line in the feed) and the game keeps running. In tests, module errors throw so that you see them.
- The module doesn't know how speed is computed. It only sets the `speed` status, which `speedOf` in `rules.ts` reads on both the server and the client.
- Blank's old tests use coins, so they fail until you replace them in step 8. That is expected.

## 6. The client: prediction, a marker, HUD, sound

`src/client/scene.ts`: import the shared rules:

```ts
import { canTag, movePlayer, RULES, speedOf } from '../shared/rules';
```

In the players `EntityLayer` factory, add a ring (replace `root.add(body, label);`):

```ts
      // A red ring marks "it"; frame() shows it, faded while "it" cannot tag yet.
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.9, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff3355', transparent: true }));
      ring.name = 'it';
      ring.position.y = 0.03;
      root.add(body, label, ring);
```

In `frame()`, predict with the real speed and update the ring. Replace the beginning of `frame()` up to the end of `this.players.forEach(…)`:

```ts
    const world = this.world;
    if (!world) return;
    // Predict with the same speed the server uses (boosts, the "it" bonus): shared rules, world data.
    const me = world.players[this.meId];
    if (this.local && this.input && me) movePlayer(this.local, this.input, dt, speedOf(world, me));
    const renderTime = this.clock.now();
    this.players.forEach((object, player) => {
      const at = player.id === this.meId && this.local ? this.local : this.tracks.sample(player.id, renderTime) ?? player;
      object.position.set(at.x, 0, at.z);
      const ring = object.getObjectByName('it') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      ring.visible = world.it === player.id;
      ring.material.opacity = canTag(world, player) ? 1 : 0.3;
    });
```

`src/client/main.ts`: change the `GameUi` texts and the roster so they describe Tag:

```ts
  description: 'One player is "it" (red ring). Everyone else scores a point per second. Touch someone to pass "it" on; green cones are speed boosts.',
  help: 'WASD move · Enter chat (/bot adds a bot) · F3 network',
  roster: { detail: (player, world) => `${world.it === player.id ? 'IT · ' : ''}${(player as Player).score}` },
```

Add an "IT" widget next to the score (replace the `ui.top.append(…)` line):

```ts
const it = h('b', {}, '—');
ui.top.append(h('div', {}, h('span', { class: 'g-micro' }, 'SCORE '), score), h('div', {}, h('span', { class: 'g-micro' }, 'IT '), it));
```

Replace the sound bank, and subscribe to `tag.passed` next to Blank's `pickup.collected` listener:

```ts
const sounds = scope.add(new SoundBank({
  sounds: { collect: tones([[880, 0.05], [1320, 0.08]]), tag: tones([[660, 0.06], [990, 0.12]]), caught: tones([[440, 0.1], [220, 0.25]], 'square') },
}));
scope.add(net.onEvent('pickup.collected', ({ playerId }) => { if (playerId === net.id) sounds.play('collect'); }));
scope.add(net.onEvent('tag.passed', ({ from, to }) => {
  if (to === net.id) { sounds.play('caught'); ui.toasts.show('You are it!'); }
  else sounds.play('tag', { volume: from === net.id ? 1 : 0.4 });
}));
```

In the `'world'` listener, after the score line:

```ts
  it.textContent = world.it === net.id ? 'YOU' : world.players[world.it ?? '']?.name ?? '—';
```

Notes on this step:

- The ring reads `world.it` and the `tag-cooldown` status straight from the synced world, using the same `canTag` as the server. No extra messages are needed.
- `net.onEvent('tag.passed', …)` is typed: the client was created as `new GameClient<World, Input, Command, Events>` (already in Blank), so `{ from, to }` needs no cast.
- The sound comes from the forwarded bus event, not from watching `world.it` change. Events arrive once, in the tick they happened. Patches arrive at 15 Hz, can merge several changes into one, and would miss a quick double tag.
- Everything created in `main.ts` goes through `scope`. That is why you can keep editing this file while you play without ending up with duplicate listeners, sounds or canvases.

## 7. A bot

`src/server/simulation.ts`: replace `botInput`. "It" chases the nearest runner. Runners flee from "it", or grab a boost while "it" is far away:

```ts
/** `/bot` in chat: "it" chases the nearest runner; runners flee from "it", or fetch a boost while "it" is far away. */
export function botInput(world: World, id: string): Input {
  const bot = world.players[id];
  const it = world.it ? world.players[world.it] : undefined;
  if (!it) return { mx: 0, mz: 0 };
  const nearest = <T extends { x: number; z: number }>(items: T[]) =>
    items.sort((a, b) => Math.hypot(a.x - bot.x, a.z - bot.z) - Math.hypot(b.x - bot.x, b.z - bot.z))[0];
  const toward = (target: { x: number; z: number } | undefined, sign = 1): Input => {
    if (!target) return { mx: 0, mz: 0 };
    const d = Math.hypot(target.x - bot.x, target.z - bot.z) || 1;
    return { mx: ((target.x - bot.x) / d) * sign, mz: ((target.z - bot.z) / d) * sign };
  };
  if (it.id === id) return toward(nearest(Object.values(world.players).filter(p => p.online && p.id !== id)));
  if (Math.hypot(it.x - bot.x, it.z - bot.z) > 12 && Object.keys(world.pickups).length) return toward(nearest(Object.values(world.pickups)));
  return toward(it, -1);
}
```

In the game, type `/bot Chaser` and `/bot Runner` in the chat (you are the host 👑). Bots are regular players, and the engine calls this function for each of them every tick. It returns an input exactly like a client would send, so bots follow every rule, including the 2-second freeze. `/bot remove` removes them.

The freeze exists because of the bots. The first version had only "no tagging for 2 s", and three bots played ping-pong: the new "it" was still touching the old one when the cooldown ended, so a tag happened every 3 s between the same two bots. The third bot never got tagged. With the freeze (`speedOf` returns 0), runners get a real head start. In 3-minute bot games there are now about 40–80 tags, and every bot takes its turns as "it". A bot-vs-bot run is the quickest way to find rules like this.

## 8. A test

Replace `tests/simulation.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testGame } from '@gaime/core/server';
import { game } from '../src/server/game';
import { RULES, speedOf } from '../src/shared/rules';

// testGame runs the same engine as the server (clock, timers, events, systems, modules) without a network.
const setup = () => testGame(game, { random: seeded(1) });

/** Two players; after the first tick one of them is "it". */
function twoPlayers() {
  const t = setup();
  const ada = t.join('Ada');
  const bob = t.join('Bob');
  t.tick();
  const it = t.world.it!;
  return { t, it, runner: it === ada ? bob : ada };
}

describe('tag', () => {
  test('someone becomes "it"; runners score every second, "it" does not', () => {
    const { t, it, runner } = twoPlayers();
    expect(t.triggeredOf('it.chosen')).toEqual([{ playerId: it }]);
    expect(t.feed()).toContain(`${t.player(it).name} is it!`);
    // Far apart, so nobody gets tagged.
    Object.assign(t.player(it), { x: -15, z: -15 });
    Object.assign(t.player(runner), { x: 15, z: 15 });
    t.run(5);
    expect(t.player(runner).score).toBeGreaterThanOrEqual(4);
    expect(t.player(it).score).toBe(0);
  });

  test('touching passes "it" on; no tag-back during the cooldown', () => {
    const { t, it, runner } = twoPlayers();
    t.run(RULES.tagCooldown + 0.1); // the first "it" gets the cooldown too
    Object.assign(t.player(runner), { x: t.player(it).x, z: t.player(it).z });
    t.tick();
    expect(t.world.it).toBe(runner);
    expect(speedOf(t.world, t.player(runner))).toBe(0); // the new "it" counts to two
    expect(t.triggeredOf('tag.passed')).toEqual([{ from: it, to: runner }]);
    // Listed in network.events, so clients receive it too (for the sound).
    expect(t.events).toContainEqual({ name: 'tag.passed', data: { from: it, to: runner } });
    t.run(RULES.tagCooldown - 0.5); // still touching, but cooling down
    expect(t.world.it).toBe(runner);
    t.run(1);
    expect(t.world.it).toBe(it);
  });

  test('an offline "it" has a grace period; after it, someone else is chosen', () => {
    const { t, it, runner } = twoPlayers();
    t.leave(it);
    t.run(RULES.awayGrace - 1);
    expect(t.world.it).toBe(it); // may still come back (a reload, a deploy)
    t.run(1.1);
    expect(t.world.it).toBe(runner);
    expect(t.triggeredOf('it.chosen')).toHaveLength(2);
  });

  test('"it" coming back in time stays "it"; a removed "it" is replaced at once', () => {
    const { t, it, runner } = twoPlayers();
    t.leave(it);
    t.run(1);
    t.join(t.player(it).name, it);
    t.run(RULES.awayGrace);
    expect(t.world.it).toBe(it);
    t.remove(it);
    t.tick();
    expect(t.world.it).toBe(runner);
  });

  test('boost module: a boost makes you faster for a while', () => {
    const { t, runner } = twoPlayers();
    const normal = speedOf(t.world, t.player(runner));
    t.act(sim => sim.spawnPickup('boost', t.player(runner)));
    t.tick();
    expect(speedOf(t.world, t.player(runner))).toBeGreaterThan(normal);
    t.run(3.1);
    expect(speedOf(t.world, t.player(runner))).toBe(normal);
  });

  test('bots play: "it" catches somebody', () => {
    const t = setup();
    t.addBot();
    t.addBot();
    t.addBot();
    t.run(60, () => t.triggeredOf('tag.passed').length > 0);
    expect(t.triggeredOf('tag.passed').length).toBeGreaterThan(0);
  });
});
```

What `testGame` gives you:

- `join`/`leave`/`addBot` go through the same player lifecycle as the server. `run(seconds)` and `tick()` run the exact fixed steps the server runs: timers, systems and handlers.
- `triggeredOf(name)` lists the payloads of every bus event raised. `events` holds what clients would receive (forwarded bus events and `ctx.emit`). `feed()` returns the feed texts.
- `t.act(sim => …)` runs code against the game's `Sim` the way a system would, so a test can use the same helpers modules use (`spawnPickup`). Events it triggers are handled right after, as in a real tick. `t.sim()` is for reading only.
- `t.leave(id)` / `t.join(name, id)` / `t.remove(id)` trigger the same engine events as real connections, so the grace timer is tested exactly as it runs on the server.
- Periodic systems are staggered, so assert "at least 4 points in 5 s" and not "exactly 5". Add `0.1` s of margin around durations (`tagCooldown + 0.1`), because time advances in steps of 1/30 s.
- `run(60, until)` stops as soon as `until()` returns true. That keeps bot-vs-bot tests fast.

## 9. Run everything

```sh
npm run check                     # typecheck (the server runs it as a deploy gate too)
npx vitest run games/tag          # the tests above
cd games/tag && npx gaime smoke   # real WebSocket clients against the running dev server
```

In the browser: join, type `/bot` twice, and wait. The bots start tagging each other ("Runner tagged Chaser!" in the feed) and sooner or later one of them catches you. Save a server file while you are "it": the feed says "♻ New game code loaded", and you are still "it". Close the tab for more than 5 s, and a bot becomes "it". You get the "You are it!" toast, and the HUD shows `IT YOU`. Press F3 to see the network stats. `/gaime/stats` → `parts` shows what `game/tag` and `game/score` cost.

## 10. Finish

- Update `games/tag/AGENTS.md` and `docs/ADDING_FEATURES.md` so the next person's AI knows the rules of Tag. Include what "it" is, the events (`it.chosen`, `tag.passed`, `it.away`), the modifier (`tag.points`), the `STATUS` keys modules may apply, and the module kind (`pickups`). The copy still says "Blank" in a few places, including the `BlankRegistry` type name.
- Commit `games/tag` and `package-lock.json`, then push. To host the game, run `deploy/install.sh tag tag.example.com <repo>` ([DEPLOYMENT.md](DEPLOYMENT.md)).

Ideas to continue, each one a small step:

- **A bounty module**: `on: { 'tag.passed': ({ from }, sim) => … }` gives the tagger points when the tagged player was the leader. Nothing in the game changes.
- **A "last runner" modifier**: `modify: { 'tag.points': (points, { playerId }, sim) => … }` doubles the points of the runner farthest from "it".
- **Rounds of 2 minutes with a winner**: kit `createMatch()` + `stepMatch(match, world.time, present, { duration: 120 })`, or a repeating timer `ctx.every(120, 'round.ended', {}, { key: 'round' })` with an `on` handler ([KIT.md](KIT.md), [COOKBOOK.md](COOKBOOK.md)).
- **A "freeze" pickup** that stops everyone else: `status.apply(other.data, STATUS.speed, time, 2, 0)`. Prediction keeps working because it goes through `speedOf`.
- **Obstacles**: `circleRect` + `keepOutOfCircle` in `movePlayer`, which is shared, so prediction still matches.
