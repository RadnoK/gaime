# Tutorial: build "Tag" from the blank template

In about 30 minutes you turn `games/blank` into a multiplayer game of tag: one player is "it", everyone else earns a point per second, touching someone passes "it" on, and speed-boost pickups come from a module. Along the way you touch every layer of a gaime game: world state, simulation, a module, prediction, HUD, sound, a bot and a test.

Every snippet below was written and run exactly like this (typecheck, test, browser with bots).

## 0. Create the game

```sh
npm run new-game -- tag --title "Tag"
npm install
npm run dev -- tag              # http://localhost:5173 — keep it running, everything hot-reloads
```

You now have `games/tag`, a copy of Blank: players walk around a square field and collect coins. Open it in two tabs (`?player=2` in the second) to see both players.

## 1. World state: who is "it"

`src/shared/types.ts` — add two fields to `World`:

```ts
export interface World extends BaseWorld<Player> {
  pickups: Record<string, Pickup>;
  timers: Record<string, number>;
  /** Id of the player who is "it", or null. */
  it: string | null;
  /** World time of the last tag (the new "it" cannot tag back immediately). */
  taggedAt: number;
  catalog: CatalogEntry[];
}
```

`src/server/simulation.ts` — give them defaults in `createWorld()`:

```ts
export function createWorld(): World {
  return { ...baseWorld(SCHEMA), pickups: {}, timers: {}, it: null, taggedAt: 0, catalog: [] };
}
```

The running game picks this up without a restart: on hot reload the engine fills fields that are missing in the live world from `createWorld()` (the same happens for old checkpoints). No migration is needed for new fields.

## 2. Rules shared by server and client

`src/shared/rules.ts` — new constants, a `speedOf` function and a `speed` parameter for `movePlayer`:

```ts
import { clampToRect, moveTopDown, status } from '@gaime/core/kit';
import type { Input, Player, World } from './types';

export const RULES = {
  size: 40,
  speed: 8,
  playerRadius: 0.5,
  pickupRadius: 0.6,
  maxPickups: 12,
  spawnEvery: 1.5,
  /** Seconds before the new "it" may tag someone. */
  tagCooldown: 2,
  /** Points per second for everyone who is not "it". */
  scorePerSecond: 1,
  /** "It" is a little faster, or nobody would ever get caught. */
  itSpeedBonus: 1.15,
};

export const FIELD = { x: -RULES.size / 2, z: -RULES.size / 2, width: RULES.size, depth: RULES.size };

/** Current speed of a player: boosts (status 'speed') and the "it" bonus. Shared by server and client. */
export function speedOf(world: World, player: Player) {
  const boost = status.value(player.data, 'speed', world.time, 1);
  return RULES.speed * boost * (world.it === player.id ? RULES.itSpeedBonus : 1);
}

/** Shared by the server (authority) and the client (prediction). */
export function movePlayer(player: { x: number; z: number }, input: Input, dt: number, speed = RULES.speed) {
  moveTopDown(player, input, speed, dt);
  clampToRect(player, FIELD, RULES.playerRadius);
}
```

`status` (from the kit) stores timed effects in plain data (`player.data.speed` and `player.data['speed:until']`), so a boost survives a hot reload and is visible to the client, which uses the same `speedOf` for prediction.

## 3. The simulation

`src/server/simulation.ts` — import `pick` and `speedOf`, move players with their current speed, and call a new `tag()` every tick:

```ts
import { circlesOverlap, every, freeColor, pick, range, weighted } from '@gaime/core/kit';
import { movePlayer, RULES, speedOf } from '../shared/rules';

// in step(), replace the movement line:
    if (input) movePlayer(player, input, dt, speedOf(world, player));

// in step(), after the players loop:
  tag(world, dt, ctx);
```

```ts
/** Keep someone "it", score everyone else, pass "it" on by touch. */
function tag(world: World, dt: number, ctx: GameContext<World>) {
  const online = Object.values(world.players).filter(p => p.online);
  if (!world.it || !world.players[world.it]?.online) {
    world.it = pick(ctx.random, online)?.id ?? null;
    world.taggedAt = world.time;
    if (world.it) ctx.log(`${world.players[world.it].name} is it!`);
  }
  const it = world.it ? world.players[world.it] : undefined;
  if (!it) return;
  for (const player of online) if (player.id !== it.id) player.score += RULES.scorePerSecond * dt;
  if (world.time - world.taggedAt < RULES.tagCooldown) return;
  const caught = online.find(p => p.id !== it.id && circlesOverlap(it, RULES.playerRadius, p, RULES.playerRadius));
  if (!caught) return;
  world.it = caught.id;
  world.taggedAt = world.time;
  ctx.log(`${it.name} tagged ${caught.name}!`);
  ctx.emit('sound', { kind: 'tag' });
}
```

Things to notice:

- Randomness comes from `ctx.random` and time from `world.time` — both are controllable in tests. Never `Math.random()` or `Date.now()` in the simulation.
- `ctx.log` writes to the feed everyone sees (and that is saved); `ctx.emit` sends a one-off event (a sound) that is not stored.
- Save the file: the server hot-reloads, the room keeps running, and the first online player becomes "it".

## 4. A module: speed boost

Content that others might want to add lives in modules. Blank's module kind is `pickups`. Create `src/features/boost/server.ts`:

```ts
import { status } from '@gaime/core/kit';
import type { Feature } from '../../shared/types';

export default {
  author: 'tutorial',
  description: 'A speed boost pickup.',
  pickups: [{
    id: 'boost',
    name: 'Boost',
    description: '60% faster for 4 seconds.',
    value: 0,
    weight: 2,
    visual: { shape: 'cone', color: '#7dff9b', emissive: '#2a8a4a', scale: 0.7, lift: 0.3 },
    onPickup(world, player) {
      status.apply(player.data, 'speed', world.time, 4, 1.6);
    },
  }],
} satisfies Feature;
```

No registration anywhere: the registry globs `src/features/*/server.ts`, and the dev server notices the new directory. Green cones start spawning.

## 5. The client: prediction, a marker, a HUD widget, a sound

`src/client/scene.ts` — predict with the real speed and draw a ring under "it":

```ts
import { movePlayer, RULES, speedOf } from '../shared/rules';

// in the players EntityLayer factory, before `root.add(...)`:
      // A red ring marks whoever is "it"; frame() toggles it.
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.9, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff3355' }));
      ring.name = 'it';
      ring.position.y = 0.03;
      root.add(body, label, ring);

// in frame():
    const me = this.world.players[this.meId];
    if (this.local && this.input && me) movePlayer(this.local, this.input, dt, speedOf(this.world, me));
// …and inside this.players.forEach, after setting the position:
      object.getObjectByName('it')!.visible = this.world!.it === player.id;
```

`src/client/main.ts` — show who is "it", round the scores, play the tag sound:

```ts
import { SoundBank, tones } from '@gaime/core/audio';

// GameUi options:
  roster: { detail: player => String(Math.floor((player as Player).score)) },

// after `const score = …`:
const it = h('b', {}, '—');
ui.top.append(h('div', {}, h('span', { class: 'g-micro' }, 'SCORE '), score), h('div', {}, h('span', { class: 'g-micro' }, 'IT '), it));
const sounds = scope.add(new SoundBank({ sounds: { tag: tones([[660, 0.08], [990, 0.14]]) } }));
scope.add(net.on('event', (name, data) => { if (name === 'sound') sounds.play((data as { kind: string }).kind); }));

// in the 'world' listener:
  score.textContent = String(Math.floor(world.players[net.id]?.score ?? 0));
  it.textContent = world.it === net.id ? 'YOU!' : world.players[world.it ?? '']?.name ?? '—';
```

Everything created in `main.ts` goes through `scope` — that is what lets you keep editing this file while playing without duplicating listeners, sounds or canvases.

## 6. A bot

`src/server/game.ts` — replace the `bot` brain: chase when "it", flee otherwise.

```ts
  // `/bot` in chat: chases the nearest player when it is "it", runs away from "it" otherwise.
  bot(world, id) {
    const bot = world.players[id];
    const others = Object.values(world.players).filter(p => p.online && p.id !== id);
    const it = world.it ? world.players[world.it] : undefined;
    const target = bot.id === world.it
      ? others.sort((a, b) => Math.hypot(a.x - bot.x, a.z - bot.z) - Math.hypot(b.x - bot.x, b.z - bot.z))[0]
      : it;
    if (!target) return { mx: 0, mz: 0 };
    const d = Math.hypot(target.x - bot.x, target.z - bot.z) || 1;
    const away = bot.id === world.it ? 1 : -1;
    return { mx: ((target.x - bot.x) / d) * away, mz: ((target.z - bot.z) / d) * away };
  },
```

In the game type `/bot Chaser` and `/bot Runner` in the chat (you are the host 👑). Bots are regular players driven by this function every tick; `/bot remove` removes them.

## 7. A test

Replace `tests/simulation.test.ts` (Blank's tests assumed whole-number scores) with `tests/tag.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { seeded } from '@gaime/core';
import { testContext } from '@gaime/core/server';
import { registry } from '../src/server/registry';
import { createPlayer, createWorld, prepareWorld, step } from '../src/server/simulation';
import { RULES } from '../src/shared/rules';

describe('tag', () => {
  test('someone is it, the others score, touching passes it on', () => {
    const world = createWorld();
    const { ctx, events } = testContext(world, { random: seeded(2) });
    world.players.a = createPlayer(world, 'a', 'Ada');
    world.players.b = createPlayer(world, 'b', 'Bob');
    prepareWorld(world, registry);
    const run = (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 30) { world.time += 1 / 30; step(world, registry, {}, 1 / 30, ctx); } };
    run(1);
    const it = world.it!;
    const other = it === 'a' ? 'b' : 'a';
    expect(world.players[other].score).toBeGreaterThan(0.9);
    expect(world.players[it].score).toBe(0);
    Object.assign(world.players[other], { x: world.players[it].x, z: world.players[it].z });
    run(RULES.tagCooldown);
    expect(world.it).toBe(other);
    expect(events.some(e => e.name === 'sound')).toBe(true);
  });
});
```

```sh
npm run check
npx vitest run games/tag
cd games/tag && npx gaime smoke          # real WebSocket clients against the running dev server
```

## 8. Finish

- Update `games/tag/AGENTS.md` and `docs/ADDING_FEATURES.md` so the next person's AI knows the rules of Tag (what "it" is, which module kinds exist).
- Commit `games/tag` and `package-lock.json`, push. To host it: `deploy/install.sh tag tag.example.com <repo>` ([DEPLOYMENT.md](DEPLOYMENT.md)).

Ideas to continue, each a small step with the kit ([KIT.md](KIT.md)): rounds of 2 minutes with a winner (`createMatch`, `stepMatch({ duration: 120 })`), teams (`balancedTeam`), a "freeze" pickup that stops everyone else (`status.apply` on others), obstacles (`circleRect` + `keepOutOfCircle`), a leaderboard over RPC (`requests`).
