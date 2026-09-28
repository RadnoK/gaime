# Cookbook

Short, copyable recipes for things most games need. They assume the structure of the templates (`World`, `Events`, `Modifiers` and `Sim` in `src/shared/types.ts`, systems/`step`/`command` in `src/server/simulation.ts`, `defineGame` in `src/server/game.ts`, client in `src/client/`). The mechanisms — systems, timers, events, modifiers, module commands — are explained in [SIMULATION.md](SIMULATION.md). Kit functions come from `@gaime/core/kit` ([KIT.md](KIT.md)); server APIs from [SERVER.md](SERVER.md); client APIs from [CLIENT.md](CLIENT.md).

What players see and touch — HUD, menus, looks, sounds, content — is the game's own design; the client recipes below only show how to wire such things up.

- [Timed rounds with a winner](#timed-rounds-with-a-winner)
- [Hitscan weapon with a cooldown](#hitscan-weapon-with-a-cooldown)
- [Projectiles](#projectiles)
- [Kill gives gold: events](#kill-gives-gold-events)
- [Armor and buffs: modifiers](#armor-and-buffs-modifiers)
- [Buffs, slows, stuns](#buffs-slows-stuns)
- [Periodic spawning](#periodic-spawning)
- [Delayed things: timers](#delayed-things-timers)
- [A module that adds a player action](#a-module-that-adds-a-player-action)
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

// a system in the input phase, so the rest of the tick sees the new phase
// systems: [{ id: 'match', phase: 'input', run: match }, …]
export function match(sim: Sim) {
  const { world } = sim;
  const present = Object.values(world.players).filter(p => p.online).map(p => p.id);
  const event = stepMatch(world.match, world.time, present, { minPlayers: 2, countdown: 3, duration: 120, resultSeconds: 8 });
  if (event === 'start') {
    for (const p of Object.values(world.players)) p.score = 0;
    sim.log(`Round ${world.match.round}!`);
    sim.trigger('round.started', { round: world.match.round });        // modules can react
  }
  if (event === 'timeout') {
    const best = Object.values(world.players).sort((a, b) => b.score - a.score)[0];
    world.match.winner = best?.id ?? null;
    sim.log(best ? `${best.name} wins!` : 'Draw.');
    sim.trigger('round.ended', { round: world.match.round, winner: best?.id });
  }
}
// other systems and step: `if (world.match.phase !== 'playing') return;` freezes gameplay outside rounds;
// end early with endMatch(world.match, world.time, winnerId, 'reason')

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

`player.cooldowns: Record<string, number>` is a plain field; the client can show `cooldown.remaining(me.cooldowns, 'gun', world.time)`. `damage` is one of the game's `Sim` helpers: it runs the amount through `modify`, subtracts it and triggers the death event (next two recipes), so every weapon goes through the same path.

## Projectiles

```ts
import { launch, stepProjectiles, type Projectile } from '@gaime/core/kit';
// World: projectiles: Record<string, Projectile>; network.entities: [..., 'projectiles']

// fire (command or input):
const id = `p${ctx.nextId()}`;
world.projectiles[id] = launch({ id, kind: 'rocket', owner: player.id, from: player, angle: player.angle, speed: 25, radius: 0.3, life: 2, time: world.time });

// in a system (runs every tick):
stepProjectiles(world.projectiles, {
  dt, time: world.time,
  hit: p => Object.values(world.enemies).find(e => Math.hypot(e.x - p.x, e.z - p.z) < 0.6 + p.radius),
  solid: point => Math.hypot(point.x, point.z) > ARENA_RADIUS,
  onImpact: (p, target, at) => { if (target) damage(target, 30, p.owner); addEffect(world.effects, ctx.nextId(), 'explosion', world.time, at, { radius: 2 }); },
});
```

Piercing shots: return `true` from `onImpact`; a target with an `id` is hit at most once per projectile, and `wasHit(p, target.id)` in `hit` lets it find the next one behind. Side views: simulate on x (right) / z (up) with `gravity: { x: 0, z: -25 }`; see `games/duel`. Render with an `EntityLayer` keyed by `kind` and interpolate positions like other entities.

## Kill gives gold: events

Declare the fact once, trigger it in the one place it happens, and let anyone react:

```ts
// src/shared/types.ts
export type Events = {
  /** An enemy died; `by` is the player who dealt the last hit. */
  'enemy.died': { enemy: string; kind: string; by?: string; x: number; z: number };
};

// a helper of the game's Sim (built in makeSim, where `world` and `ctx` are in scope) — the only place enemies die
hurtEnemy(enemy, amount, by) {
  enemy.hp -= amount;
  if (enemy.hp > 0) return;
  delete world.enemies[enemy.id];
  ctx.cancel(`enemy:${enemy.id}:`, { prefix: true });          // its timers go with it
  ctx.trigger('enemy.died', { enemy: enemy.id, kind: enemy.kind, by, x: enemy.x, z: enemy.z });
},

// src/features/ola-bounty/server.ts — a module, no core change
export default {
  author: 'Ola',
  on: {
    'enemy.died': ({ by, kind }, sim) => {
      const player = by ? sim.world.players[by] : undefined;
      if (player) player.gold += kind === 'boss' ? 50 : 5;
    },
  },
} satisfies Feature;
```

Handlers run right after the code that triggered the event, in the same tick — the game's first, then modules' in file order. Pass ids, not objects, and check that the entity still exists. For a death sound on clients add `'enemy.died'` to `network.events` ([Sounds](#sounds-screen-shake-rumble)).

The engine adds its own events to every game's bus: `player.joined` `{ player, bot }`, `player.online`, `player.offline`, `player.removed` `{ player, name }` — e.g. `on: { 'player.joined': ({ player }, sim) => { sim.world.players[player].gold = 50; } }` gives every newcomer starting gold from a module.

## Armor and buffs: modifiers

When several modules may want to change a number, the game asks for it through `modify` instead of hard-coding conditions:

```ts
// src/shared/types.ts
export type Modifiers = {
  /** Damage a player is about to take. */
  'player.damage': { player: string; source: string };
  /** Gold an enemy is worth for the player who killed it. */
  'enemy.bounty': { player: string; kind: string };
};

// the game
const amount = sim.modify('player.damage', def.damage, { player: player.id, source: enemy.kind });
const gold = sim.modify('enemy.bounty', def.bounty, { player: by, kind: enemy.kind });

// src/features/ola-armor/server.ts
modify: {
  'player.damage': (amount, { player }, sim) => sim.world.players[player]?.armor ? amount * 0.7 : amount,
},
// src/features/ola-shield/server.ts — a timed buff from the kit, applied as a modifier
modify: {
  'player.damage': (amount, { player }, sim) => status.active(sim.world.players[player].data, 'ola-shield', sim.world.time) ? 0 : amount,
},
```

Modifiers run in order (the game's, then modules' in file order), each receiving the previous result; returning `undefined` keeps the value. A throwing modifier is skipped and its module switched off. `games/blank` does this for `pickup.points` (the `combo` module doubles them). Pass `Modifiers` to `defineGame<World, Input, Sim, Events, Modifiers>` and `FeatureModule<…, Modifiers>` so names are checked.

Modifiers run **on the server only**. A value the client predicts — movement speed, collision size — must not depend on a modifier: compute it in a shared function in `src/shared/rules.ts` from world data (`speedOf(world, player)` reading a status in `player.data`), used by both the server and the client's prediction. Otherwise the player rubber-bands.

## Buffs, slows, stuns

```ts
import { status } from '@gaime/core/kit';

status.apply(enemy.data, 'slow', world.time, 3, 0.4);           // 40% speed for 3 s (longest end time wins)
const speed = def.speed * status.value(enemy.data, 'slow', world.time, 1);
if (status.active(player.data, 'stun', world.time)) return;      // skip input while stunned
status.apply(player.data, 'shield', world.time, 5);              // boolean flag with a duration
```

The values live in `data`, so they are saved, hot-reload-safe and visible to the client (e.g. to tint a slowed enemy). A status is state you **read** — combine it with a modifier (previous recipe) when other modules should see its effect, and with a timer (below) when something must **happen** when it ends.

## Periodic spawning

A spawner is a system with `every`:

```ts
import { pointOnCircle, weighted } from '@gaime/core/kit';

// defineGame({ systems: [{ id: 'spawn', every: 2, run: sim => spawn(sim, registry) }] })
export function spawn(sim: Sim, registry: Registry) {
  const { world } = sim;
  if (Object.keys(world.enemies).length >= 50) return;
  const def = weighted(sim.random, registry.lists.enemies, d => d.weight ?? 1);
  if (!def) return;
  const at = pointOnCircle(sim.random, { x: 0, z: 0 }, 28);
  const id = `e${sim.nextId()}`;
  world.enemies[id] = { id, kind: def.id, ...at, hp: def.hp, data: {} };
  sim.trigger('enemy.spawned', { enemy: id, kind: def.id });
}
```

The engine runs it every 2 s of world time (not while paused), passes the real elapsed `dt`, staggers it against other periodic systems so they do not all land on one tick, and lists it in `/gaime/stats` → `parts`. A module can add its own spawner the same way — `systems: [{ id: 'swarm', every: 10, run: … }]` in its `server.ts`. `games/blank/src/server/game.ts` spawns pickups like this.

For a per-entity rhythm inside code that already runs every tick (an enemy that slams every 6 s), the kit `every(enemy.data, 'slam', world.time, 6)` is still fine ([KIT.md](KIT.md#kit-timers-or-engine-timers)).

## Delayed things: timers

Something that must happen once, later, is a timer — an event scheduled for a moment of world time, saved in `world.schedule`. (`ctx` is the `GameContext`; module code reaches the same calls through the game's `Sim`.)

```ts
// a bomb that explodes after 3 s
const id = `b${ctx.nextId()}`;
ctx.world.bombs[id] = { id, x, z, owner: player.id };
ctx.after(3, 'bomb.exploded', { bomb: id }, { key: `bomb:${id}` });

// the handler does the work
on: {
  'bomb.exploded': ({ bomb }, sim) => {
    const b = sim.world.bombs[bomb];
    if (!b) return;                                // defused or removed in the meantime
    delete sim.world.bombs[bomb];
    for (const enemy of nearby(sim.world, b, 3)) sim.hurtEnemy(enemy, 40, b.owner);
  },
},

// defusing: cancel by key
ctx.cancel(`bomb:${id}`);

// a respawn, keyed by the player so it is cancelled automatically if they are removed
ctx.after(5, 'player.respawn', { player: player.id }, { key: `player:${player.id}:respawn` });

// a burn that ticks five times
ctx.every(1, 'burn.tick', { enemy: enemy.id }, { key: `enemy:${enemy.id}:burn`, times: 5 });
```

- Timers run on world time: pauses stop them, hot reloads and restarts keep them. They cost O(log n) — thousands are fine.
- Give every timer that may need cancelling a key prefixed by its owner; scheduling the same key again replaces it. `ctx.timeLeft(key)` returns the seconds left (e.g. for a HUD countdown you put in the world).
- Keys starting with `player:<id>:` are cancelled when that player is removed; cancel entity timers yourself when the entity goes away (`ctx.cancel('enemy:<id>:', { prefix: true })`).
- `games/blank` gives every pickup an expiry timer (`pickup:<id>`) and cancels it when the pickup is collected.

## A module that adds a player action

A module can add commands without touching the game's `command`:

```ts
// src/features/ola-teleport/server.ts
import { cooldown } from '@gaime/core/kit';

export default {
  author: 'Ola',
  description: 'Teleport to a point once every 10 s.',
  commands: {
    'ola-teleport': (playerId, command, sim) => {
      const player = sim.world.players[playerId];
      const x = Number(command.x), z = Number(command.z);
      if (!player || !Number.isFinite(x) || !Number.isFinite(z)) return 'Where to?';
      if (!cooldown.use(player.data, 'ola-teleport', sim.world.time, 10)) return 'Teleport is recharging.';
      Object.assign(player, clampToArena({ x, z }));
      sim.trigger('ola-teleport:used', { player: playerId });   // a private event: no entry in Events needed
    },
  },
} satisfies Feature;

// client
net.command({ type: 'ola-teleport', x: target.x, z: target.z });
```

Command types are global: name them `<module>-<action>` (a type claimed twice fails the registry). `net.command` accepts such types without them being part of the game's `Command` type. Validate everything; a returned string goes back to the player as a notice. Bots can use it too: `ctx.command(botId, { type: 'ola-teleport', x, z })`. How the action appears on the client (a key, a button, a menu entry) is up to the game.

## Many entities

```ts
import { SpatialHash } from '@gaime/core/kit';
const grid = new SpatialHash<Enemy>(4);          // module-level is fine: rebuilt every tick, holds no state

// in a system (or step):
grid.rebuild(Object.values(world.enemies));
for (const player of players) {
  for (const enemy of grid.query(player, 6)) { /* only enemies within 6 units */ }
}
```

Plus: run expensive thinking in a system with `every` (AI at 5 Hz instead of 30), list big dictionaries in `network.entities`, keep effect arrays pruned, raise `publishEvery` for crowds, and measure with `npm run load` and `/gaime/stats` → `parts` ([PROTOCOL.md](PROTOCOL.md#latency-and-load-testing)).

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
// server — either forward bus events that already exist…
network: { events: ['enemy.died', 'pickup.collected'] },
// …or emit ad-hoc ones
ctx.emit('sound', { kind: 'boom' });                 // everyone
ctx.emit('sound', { kind: 'hurt' }, player.id);      // one player

// client — both arrive batched per tick; type the client with the game's Events for onEvent
const net = keep(import.meta.hot, 'net', () => new GameClient<World, Input, Command, Events>({ game: 'hive' }));
const sounds = scope.add(new SoundBank({ sounds: { boom: tones([[90, 0.25], [60, 0.35]], 'sawtooth'), hurt: { url: '/audio/hurt.mp3' }, death: tones([[220, 0.1]]) } }));
scope.add(net.onEvent('enemy.died', ({ kind }) => { sounds.play(kind === 'boss' ? 'boom' : 'death'); }));
scope.add(net.on('event', (name, data) => {                // every event, e.g. untyped ctx.emit ones
  if (name !== 'sound') return;
  const { kind } = data as { kind: string };
  sounds.play(kind);
  if (kind === 'boom') { rig.shake(0.6); controls.rumble(0.7, 180); }
}));
```

Forwarded events carry their bus payload; `net.onEvent(name, listener)` subscribes to one name with the payload typed from `Events`. Neither kind is stored in the world, so late joiners never see them. `SoundBank` is an optional default — any audio code works here. Audio files go to `games/<game>/public/audio/`.

## Custom models and glTF

Per module: `src/features/<id>/client.ts` with `models: { shape: visual => object }` ([MODULES.md](MODULES.md#clientts-custom-models)). Files: put `tree.glb` in `games/<game>/public/models/` and before creating entities:

```ts
const models = new ModelLibrary();
await models.load('tree', '/models/tree.glb', { height: 3 });     // normalised to 3 units tall, standing on y = 0
// any definition with visual: { shape: 'tree' } now uses it
```

## A HUD widget and a panel

With the optional `GameUi` (a game with its own interface puts its DOM, canvas or framework here instead):

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

The host adds bots with `/bot [name]` and removes them with `/bot remove`; code can call `ctx.addBot(name)`. Bots are online players that do not take connection seats; `player.data['gaime-bot']` marks them (the roster shows 🤖). Bot-vs-bot runs make good tests: `const t = testGame(game); t.addBot(); t.addBot(); t.run(300, () => …)` ([TESTING.md](TESTING.md)).

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

Test it with an old-shaped object: `testGame(game, { world: oldWorld })` hydrates and migrates it like a save. Engine fields (`tick`, `schedule`) are filled automatically for saves from before they existed. Pending timers are saved with their event name and payload: when you rename an event or change its payload, keep a handler for the old form until those timers have fired, or drop them in `migrate` with `cancelTimers(world.schedule, '<key prefix>')` from `@gaime/core`.
