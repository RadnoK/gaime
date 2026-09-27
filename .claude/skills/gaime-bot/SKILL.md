---
name: gaime-bot
description: Write or improve the bot brain of a gaime game (GameDefinition.bot) — AI opponents and teammates that play with the same inputs and commands as humans, fill empty seats, and drive bot-vs-bot tests. Use when the user asks for bots, AI players, single-player practice, filling a lobby, or automated playtesting.
---

# Bots

A gaime bot is an online player whose input comes from a function on the server instead of a browser. It uses the **same `Input` and the same commands** as a human, so it cannot cheat and it exercises exactly the code players do. `games/blank`, `games/starter` and `games/duel` all have one (`bot` in `src/server/game.ts`, `botInput` in `simulation.ts`).

## The contract

```ts
defineGame<World, Input>({
  // …
  bot(world, botId, ctx) {             // called every tick for every bot
    const me = world.players[botId];
    if (!me || me.hp <= 0) return undefined;              // undefined = no input this tick
    // one-off actions go through the game's own command handler:
    if (/* ready to use an ability */ false) ctx.command(botId, { type: 'cast', slot: 0, x: 0, z: 0 });
    return { mx: 0, mz: 0, fire: false };                  // exactly what parseInput returns for humans
  },
});
```

- The engine enables `/bot [name]` and `/bot remove` (host only) when `bot` exists; code can call `ctx.addBot(name)` (a taken name becomes `Name 2`, `Name 3`…) and `ctx.isBot(id)`.
- Bots are created with your `createPlayer`, marked with `player.data['gaime-bot'] = true`, are always online, do not use connection seats, and show 🤖 in the roster.
- `onPlayerOnline(world, player, true, ctx)` runs for bots too — use it to seat them, and to hand a bot's seat to a joining human (see `games/duel/src/server/simulation.ts`).

## Rules

1. **Stateless between ticks** or state in `player.data['bot-…']` — module-level variables are lost on hot reload. Deterministic "personality": derive it from the id (`botId.charCodeAt(4)`) or store it in `data` on the first tick.
2. **Only public information** unless the design says otherwise — a bot that reads the opponent's hidden hand is no fun.
3. **Cheap**: it runs every tick. Use `nearest`, `SpatialHash`, cached targets in `data` (re-pick every 0.5 s with `every`). Planning that takes more than ~1 ms → a worker (`gaime-worker` skill) whose result is written to `data`.
4. **Imperfect on purpose**: add aim error (`range(ctx.random, -e, e)`), reaction delay (act only when `world.time > data['bot-seen'] + 0.3`), and a difficulty knob in the game's `RULES`.
5. **Commands through `ctx.command`**, never by mutating the world directly — refusals (cooldowns, not your turn) apply to bots as well. It returns the reply string and never throws (a bug in the command comes back as `Error in the code of command …`).
6. Turn-based games: act once per turn (store the turn number in `data`), and wait a moment before acting so humans can follow.

## Recipes

- Chase / flee: vector to the target, normalised (see the Tag tutorial in `docs/TUTORIAL.md`).
- Aim with a ballistic arc: `ballisticAngle(from, target, speed, gravity)` from the kit (`games/duel`).
- Defend a point: pick a slot on a circle around it from the id, go there when no enemy is close.
- Fill empty games: in `step`, if fewer than N humans are online and the match is in the lobby, `ctx.addBot()`; remove bots when humans arrive (`ctx.removePlayer(botId)`).

## Test with bots

Bot vs bot until someone wins is the best rule test (`games/duel/tests/simulation.test.ts`):

```ts
const { ctx } = testContext(world, { random: seeded(1), command: (id, c) => command(world, registry, id, c as Command, ctx) });
for (const id of ['a', 'b']) world.players[id].data['gaime-bot'] = true;
const brains = () => Object.fromEntries(['a', 'b'].map(id => [id, game.bot!(world, id, ctx)]).filter(([, i]) => i));
for (let i = 0; i < 1500 && !winner(world); i++) run(1, brains);
```

Pass `command` to `testContext` — otherwise bot commands are ignored. Then play against it in the browser (`/bot`) and watch a few rounds of bots only.

## Reference

`docs/SERVER.md#bots`, `docs/COOKBOOK.md#bots`, `docs/KIT.md` (nearest, cooldowns, ballisticAngle), `docs/TESTING.md` (bot-vs-bot tests).
