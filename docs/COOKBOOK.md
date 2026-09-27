# Cookbook

Short, copyable recipes for things most games need. They assume the structure of the templates (`World` in `src/shared/types.ts`, `step`/`command` in `src/server/simulation.ts`, `defineGame` in `src/server/game.ts`, client in `src/client/`). Kit functions come from `@gaime/core/kit` ([KIT.md](KIT.md)); server APIs from [SERVER.md](SERVER.md); client APIs from [CLIENT.md](CLIENT.md).

- [Timed rounds with a winner](#timed-rounds-with-a-winner)
- [Hitscan weapon with a cooldown](#hitscan-weapon-with-a-cooldown)
- [Projectiles](#projectiles)
- [Buffs, slows, stuns](#buffs-slows-stuns)
- [Periodic spawning](#periodic-spawning)
- [Many entities](#many-entities)
- [Teams](#teams)
- [Turn-based play](#turn-based-play)
- [Inventory and a shop](#inventory-and-a-shop)
- [Leaderboard over RPC](#leaderboard-over-rpc)
- [Seats and spectators](#seats-and-spectators)
- [Hidden information per player](#hidden-information-per-player)
- [Progress that survives rounds](#progress-that-survives-rounds)
- [Chat and admin commands](#chat-and-admin-commands)
- [Sounds, screen shake, rumble](#sounds-screen-shake-rumble)
- [Custom models and glTF](#custom-models-and-gltf)
- [A HUD widget and a panel](#a-hud-widget-and-a-panel)
- [Touch and gamepad](#touch-and-gamepad)
- [Bots](#bots)
- [Changing saved data](#changing-saved-data)

## Timed rounds with a winner

```ts
// types.ts
import type { MatchState } from '@gaime/core/kit';
export interface World extends BaseWorld<Player> { match: MatchState; /* … */ }

// simulation.ts
import { createMatch, endMatch, stepMatch, toLobby } from '@gaime/core/kit';
export const createWorld = (): World => ({ ...baseWorld(SCHEMA), match: createMatch(), /* … */ });

export function step(world: World, registry: R, inputs: Record<string, Input>, dt: number, ctx: GameContext<World>) {
  const present = Object.values(world.players).filter(p => p.online).map(p => p.id);
  const event = stepMatch(world.match, world.time, present, { minPlayers: 2, countdown: 3, duration: 120, resultSeconds: 8 });
  if (event === 'start') { for (const p of Object.values(world.players)) p.score = 0; ctx.log(`Round ${world.match.round}!`); }
  if (event === 'timeout') {
    const best = Object.values(world.players).sort((a, b) => b.score - a.score)[0];
    world.match.winner = best?.id ?? null;
    ctx.log(best ? `${best.name} wins!` : 'Draw.');
  }
  if (world.match.phase !== 'playing') return;      // freeze gameplay outside rounds
  // … gameplay; end early with endMatch(world.match, world.time, winnerId, 'reason')
}

// command(): { type: 'ready' } → setReady(world.match, playerId, !world.match.ready[playerId])
```

Client: `matchTimeLeft(world.match, world.time)` for the countdown/round clock (0 in the lobby, after the round and in rounds without a `duration`); show `world.match.phase` in a banner. Without ready clicks use `autoStart: true`.

## Hitscan weapon with a cooldown

```ts
import { cooldown, raycast, rayEnd, addEffect } from '@gaime/core/kit';

if (input.fire && cooldown.use(player.cooldowns, 'gun', world.time, 0.15)) {
  const hit = raycast(player, player.angle, 22, Object.values(world.enemies), e => registry.kinds.enemies[e.kind]?.radius ?? 0.5);
  const end = hit?.point ?? rayEnd(player, player.angle, 22);
  addEffect(world.effects, ctx.nextId(), 'tracer', world.time, player, { x2: end.x, z2: end.z, color: player.color });
  if (hit) damage(hit.item, 12, player.id);
}
```

`player.cooldowns: Record<string, number>` is a plain field; the client can show `cooldown.remaining(me.cooldowns, 'gun', world.time)`.

## Projectiles

```ts
import { launch, stepProjectiles, type Projectile } from '@gaime/core/kit';
// World: projectiles: Record<string, Projectile>; network.entities: [..., 'projectiles']

// fire (command or input):
const id = `p${ctx.nextId()}`;
world.projectiles[id] = launch({ id, kind: 'rocket', owner: player.id, from: player, angle: player.angle, speed: 25, radius: 0.3, life: 2, time: world.time });

// every tick:
stepProjectiles(world.projectiles, {
  dt, time: world.time,
  hit: p => Object.values(world.enemies).find(e => Math.hypot(e.x - p.x, e.z - p.z) < 0.6 + p.radius),
  solid: point => Math.hypot(point.x, point.z) > ARENA_RADIUS,
  onImpact: (p, target, at) => { if (target) damage(target, 30, p.owner); addEffect(world.effects, ctx.nextId(), 'explosion', world.time, at, { radius: 2 }); },
});
```

Piercing shots: return `true` from `onImpact`; a target with an `id` is hit at most once per projectile, and `wasHit(p, target.id)` in `hit` lets it find the next one behind. Side views: simulate on x (right) / z (up) with `gravity: { x: 0, z: -25 }`; see `games/duel`. Render with an `EntityLayer` keyed by `kind` and interpolate positions like other entities.

## Buffs, slows, stuns

```ts
import { status } from '@gaime/core/kit';

status.apply(enemy.data, 'slow', world.time, 3, 0.4);           // 40% speed for 3 s (longest end time wins)
const speed = def.speed * status.value(enemy.data, 'slow', world.time, 1);
if (status.active(player.data, 'stun', world.time)) return;      // skip input while stunned
status.apply(player.data, 'shield', world.time, 5);              // boolean flag with a duration
```

The values live in `data`, so they are saved, hot-reload-safe and visible to the client (e.g. to tint a slowed enemy).

## Periodic spawning

```ts
import { every, pointOnCircle, weighted } from '@gaime/core/kit';
// World: timers: Record<string, number>  (list it in network.hidden)

if (every(world.timers, 'spawn', world.time, 2) && Object.keys(world.enemies).length < 50) {
  const def = weighted(ctx.random, registry.lists.enemies, d => d.weight ?? 1);
  const at = pointOnCircle(ctx.random, { x: 0, z: 0 }, 28);
  if (def) world.enemies[`e${ctx.nextId()}`] = { id: `e${ctx.nextId()}`, kind: def.id, ...at, hp: def.hp, data: {} } as Enemy;
}
```

`every` skips intervals missed during pauses instead of spawning a burst: after a long gap it fires once, then again a full interval later.

## Many entities

```ts
import { SpatialHash } from '@gaime/core/kit';
const grid = new SpatialHash<Enemy>(4);          // module-level is fine: rebuilt every tick, holds no state

// in step():
grid.rebuild(Object.values(world.enemies));
for (const player of players) {
  for (const enemy of grid.query(player, 6)) { /* only enemies within 6 units */ }
}
```

Plus: list big dictionaries in `network.entities`, keep effect arrays pruned, raise `publishEvery` for crowds, and measure with `npm run load` ([PROTOCOL.md](PROTOCOL.md#latency-and-load-testing)).

## Teams

```ts
import { balancedTeam, TEAM_COLORS } from '@gaime/core/kit';
const TEAMS = ['red', 'blue'];

export function createPlayer(world: World, id: string, name: string): Player {
  const team = balancedTeam(TEAMS, Object.values(world.players).map(p => p.team));
  return { id, name, online: true, data: {}, team, color: TEAM_COLORS[TEAMS.indexOf(team)], /* … */ };
}
// friendly fire off: if (attacker.team === victim.team) return;
```

## Turn-based play

```ts
import { createTurns, freezeTurn, isTurnOf, nextTurn, resumeTurn, turnExpired } from '@gaime/core/kit';

world.turns = createTurns(order, world.time, 30);                 // on round start
// command:
if (!world.turns || !isTurnOf(world.turns, playerId)) return 'Not your turn.';
// resolving something that takes time (a shot, an animation):
freezeTurn(world.turns, world.time);            // … later: resumeTurn(world.turns, world.time, 3)
// every tick:
if (turnExpired(world.turns, world.time)) nextTurn(world.turns, world.time, 30, id => world.players[id]?.hp > 0);
```

`games/duel/src/server/simulation.ts` is a complete example (fire → freeze → shells resolve → retreat → next turn).

## Inventory and a shop

```ts
import { addItem, takeItem, hasItem } from '@gaime/core/kit';
// Player: items: Record<string, number>, gold: number

// command { type: 'buy', item }
const def = registry.kinds.items[command.item];
if (!def) return 'Unknown item.';
if (player.gold < def.price) return 'Not enough gold.';
player.gold -= def.price;
addItem(player.items, def.id, 1, def.max ?? 99);

// using an item
if (!takeItem(player.items, 'potion')) return 'No potions.';
```

The shop list is in `world.catalog`; for prices that depend on the player, answer with a request (next recipe).

## Leaderboard over RPC

```ts
// game.ts
requests: {
  leaderboard: world => Object.values(world.players).map(p => ({ name: p.name, score: Math.floor(p.score) })).sort((a, b) => b.score - a.score).slice(0, 10),
},
// client
const rows = await net.request<Array<{ name: string; score: number }>>('leaderboard');
ui.toasts.show(rows.map((r, i) => `${i + 1}. ${r.name} — ${r.score}`).join('\n'));
```

Requests are for data the client asks for occasionally; state everyone needs continuously belongs in the world.

## Seats and spectators

`games/duel`: `keepPlayers: false` (leaving frees the seat), `createPlayer` assigns `seat: 0 | 1 | -1`, gameplay only looks at seated players, and `onPlayerOnline` lets a human take a bot's seat. Spectators get the same world and a banner saying they are watching.

## Hidden information per player

The world goes to every client. For secrets (cards in hand, fog of war), filter it per player with `view`:

```ts
defineGame<World, Input>({
  // …
  view: (world, playerId) => ({
    ...world,
    hands: { [playerId]: world.hands[playerId] ?? [] },            // only your own hand
    deck: [],                                                      // nobody sees the deck
  }),
});
```

`view` receives the network projection (never the authoritative world) and must return a new object instead of mutating it. It costs one diff per client per publish. One-off private messages: `ctx.notify(playerId, text)` or `ctx.emit(name, data, playerId)`.

## Progress that survives rounds

Keep long-term fields on the player (`wins`, `xp`, `unlocked`) and reset only round fields when a round starts. With `keepPlayers: true` (default) a player's character — and its progress — comes back with the same browser identity, even after server restarts. Across different browsers there is no account system; add one via `routes` and your own auth if you need it.

## Chat and admin commands

```ts
chat: {
  commands: {
    roll: { description: 'roll a die', usage: '[sides]', run: (world, id, args, ctx) => { ctx.log(`${world.players[id].name} rolled ${1 + Math.floor(ctx.random() * (Number(args) || 6))}`); } },
    reset: { description: 'reset the scores', host: true, run: world => { for (const p of Object.values(world.players)) p.score = 0; } },
  },
  filter: text => text.replace(/badword/gi, '***'),
},
admin: {
  spawn: { description: 'spawn <enemy> [count]', run: (world, [enemy, count], ctx) => ({ queued: Number(count) || 1 }) },
},
```

Chat: `/help` lists everything; returning a string answers privately. Admin: `npx gaime admin spawn beetle 5` (inside the game directory; token handled automatically).

## Sounds, screen shake, rumble

```ts
// server
ctx.emit('sound', { kind: 'boom' });                 // everyone
ctx.emit('sound', { kind: 'hurt' }, player.id);      // one player

// client
const sounds = scope.add(new SoundBank({ sounds: { boom: tones([[90, 0.25], [60, 0.35]], 'sawtooth'), hurt: { url: '/audio/hurt.mp3' } } }));
scope.add(net.on('event', (name, data) => {
  if (name !== 'sound') return;
  const { kind } = data as { kind: string };
  sounds.play(kind);
  if (kind === 'boom') { rig.shake(0.6); controls.rumble(0.7, 180); }
}));
```

Audio files go to `games/<game>/public/audio/`.

## Custom models and glTF

Per module: `src/features/<id>/client.ts` with `models: { shape: visual => object }` ([MODULES.md](MODULES.md#clientts-custom-models)). Files: put `tree.glb` in `games/<game>/public/models/` and before creating entities:

```ts
const models = new ModelLibrary();
await models.load('tree', '/models/tree.glb', { height: 3 });     // normalised to 3 units tall, standing on y = 0
// any definition with visual: { shape: 'tree' } now uses it
```

## A HUD widget and a panel

```ts
import { h, meter, escapeHtml } from '@gaime/core/ui';

const gold = h('b', {}, '0');
ui.top.append(h('div', {}, h('span', { class: 'g-micro' }, 'GOLD '), gold));
const hp = meter('var(--g-ok)');
ui.center.append(hp.element);

const shop = ui.dialog('Shop', 'Click to buy');
shop.body.addEventListener('click', event => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-item]')?.dataset.item;
  if (item) net.command({ type: 'buy', item });
});
scope.add(net.on('world', world => {
  const me = world.players[net.id];
  gold.textContent = String(me?.gold ?? 0);
  hp.set((me?.hp ?? 0) / 100);
  shop.setContent(world.catalog.filter(e => e.kind === 'items').map(e => `<button class="g-button" data-item="${escapeHtml(e.id)}">${escapeHtml(e.name)} — ${escapeHtml(e.price)}</button>`).join(''));
}));
// open with a key: if (controls.pressed('shop')) shop.toggle();
```

## Touch and gamepad

Bind every action to all devices and add on-screen controls; they only show on touch screens:

```ts
const controls = scope.add(new Controls({
  element: surface,
  actions: { fire: ['Mouse0', 'Space', 'Pad:RT', 'Touch:fire'], jump: ['KeyJ', 'Pad:A', 'Touch:jump'] },
  axes: { move: WASD, aim: { stick: 'right', touch: 'aim' } },
}));
scope.add(new TouchControls(app, controls, { sticks: ['move', 'aim'], buttons: [{ name: 'fire', label: '●' }, { name: 'jump', label: '⤒' }] }));
```

`controls.device` tells you what was used last (to show the right hints).

## Bots

```ts
defineGame({
  // …
  bot(world, botId, ctx) {
    const me = world.players[botId];
    const target = nearest(me, Object.values(world.enemies), 20);
    if (target && cooldown.ready(me.cooldowns, 'dash', world.time)) ctx.command(botId, { type: 'cast', slot: 0, x: target.x, z: target.z });
    return { mx: target ? Math.sign(target.x - me.x) : 0, mz: 0, fire: !!target };   // same Input as a client
  },
});
```

The host adds bots with `/bot [name]` and removes them with `/bot remove`; code can call `ctx.addBot(name)`. Bots are online players that do not take connection seats; `player.data['gaime-bot']` marks them (the roster shows 🤖). Bot-vs-bot runs make good tests.

## Changing saved data

New fields: just add them with defaults to `createWorld`/`createPlayer`. Changed fields: bump `SCHEMA` and migrate:

```ts
migrate(world) {
  if (world.schema < 2) {
    for (const player of Object.values(world.players)) (player as Player).gold = ((player as any).coins ?? 0) * 10;
    world.schema = 2;
  }
  return world;
},
```

Test it with an old-shaped object: `hydrate(oldWorld, createWorld(), template)` then `game.migrate(...)`.
