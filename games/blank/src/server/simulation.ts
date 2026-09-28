import { baseWorld } from '@gaime/core';
import { circlesOverlap, freeColor, range, weighted } from '@gaime/core/kit';
import type { GameContext } from '@gaime/core/server';
import type { Command, Events, Input, Player, Sim, World } from '../shared/types';
import { movePlayer, RULES } from '../shared/rules';
import type { BlankRegistry } from './registry';

export const SCHEMA = 1;
type Ctx = GameContext<World, Events>;

export function createWorld(): World {
  return { ...baseWorld(SCHEMA), pickups: {}, catalog: [] };
}

export function createPlayer(world: World, id: string, name: string, random = Math.random): Player {
  const half = RULES.size / 2 - 2;
  return {
    id, name, online: true, data: {},
    x: range(random, -half, half), z: range(random, -half, half),
    color: freeColor(Object.values(world.players).map(p => p.color)),
    score: 0,
  };
}

/** After load and every hot reload: refresh the catalog, drop pickups of removed modules. */
export function prepareWorld(world: World, registry: BlankRegistry) {
  world.catalog = registry.catalog;
  for (const pickup of Object.values(world.pickups)) if (!registry.kinds.pickups[pickup.kind]) delete world.pickups[pickup.id];
}

/** The facade module code works with: built once per tick by the engine (`GameDefinition.sim`). */
export function makeSim(registry: BlankRegistry, ctx: Ctx, dt: number): Sim {
  const world = ctx.world;
  const sim: Sim = {
    world, dt,
    random: ctx.random,
    trigger: (event: string, data?: unknown) => ctx.trigger(event as `${string}:${string}`, data),
    after: (seconds: number, event: string, data?: unknown, options?: { key?: string }) => { ctx.after(seconds, event as `${string}:${string}`, data, options); },
    cancel: key => { ctx.cancel(key); },
    modify: (name, value, data) => ctx.modify(name, value, data),
    log: ctx.log,
    emit: ctx.emit,
    isolate: (module, run) => ctx.isolate(module, run),
    spawnPickup(kind, at) {
      const def = kind ? registry.kinds.pickups[kind] : weighted(ctx.random, registry.lists.pickups, d => d.weight);
      if (!def) return undefined;
      const half = RULES.size / 2 - 1;
      const id = `p${ctx.nextId()}`;
      const pickup = { id, kind: def.id, x: at?.x ?? range(ctx.random, -half, half), z: at?.z ?? range(ctx.random, -half, half) };
      world.pickups[id] = pickup;
      // Keyed by the pickup, so collecting it can cancel the timer.
      ctx.after(def.life ?? RULES.pickupLife, 'pickup.expired', { pickup: id }, { key: `pickup:${id}` });
      ctx.trigger('pickup.spawned', { pickup: id, kind: def.id });
      return pickup;
    },
  };
  return sim;
}

/** Per-tick input handling: move every online player by their input. */
export function step(world: World, inputs: Readonly<Record<string, Input>>, dt: number) {
  for (const player of Object.values(world.players)) {
    const input = inputs[player.id];
    if (player.online && input) movePlayer(player, input, dt);
  }
}

/** System: players touching pickups collect them. Points go through the `pickup.points` modifiers. */
export function collect(sim: Sim, registry: BlankRegistry) {
  const { world } = sim;
  for (const player of Object.values(world.players)) {
    if (!player.online) continue;
    for (const pickup of Object.values(world.pickups)) {
      if (!circlesOverlap(player, RULES.playerRadius, pickup, RULES.pickupRadius)) continue;
      delete world.pickups[pickup.id];
      sim.cancel(`pickup:${pickup.id}`);
      const def = registry.kinds.pickups[pickup.kind];
      if (!def) continue;
      const points = sim.modify('pickup.points', def.value, { playerId: player.id, kind: def.id });
      sim.trigger('pickup.collected', { playerId: player.id, pickup: pickup.id, kind: def.id, points });
      // A definition hook belongs to its module: an error switches that module off, not the game.
      if (def.onPickup) sim.isolate(registry.owner[`pickups/${def.id}`], () => def.onPickup!(sim, player, pickup));
    }
  }
}

/** System (every RULES.spawnEvery s): keep the field stocked. */
export function spawn(sim: Sim) {
  if (Object.keys(sim.world.pickups).length < RULES.maxPickups) sim.spawnPickup();
}

export function command(world: World, playerId: string, command: Command, ctx: Ctx): string | void {
  if (command.type === 'reset-scores') {
    if (!ctx.isHost(playerId)) return 'Only the host can reset the scores.';
    for (const player of Object.values(world.players)) player.score = 0;
    ctx.log('Scores reset.');
    return;
  }
  return `Unknown command ${(command as { type: string }).type}.`;
}

/** `/bot` in chat: walks to the nearest pickup. */
export function botInput(world: World, id: string): Input {
  const bot = world.players[id];
  const target = Object.values(world.pickups).sort((a, b) => Math.hypot(a.x - bot.x, a.z - bot.z) - Math.hypot(b.x - bot.x, b.z - bot.z))[0];
  if (!target) return { mx: 0, mz: 0 };
  const d = Math.hypot(target.x - bot.x, target.z - bot.z) || 1;
  return { mx: (target.x - bot.x) / d, mz: (target.z - bot.z) / d };
}
