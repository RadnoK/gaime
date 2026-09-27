import { baseWorld } from '@gaime/core';
import { circlesOverlap, every, freeColor, range, weighted } from '@gaime/core/kit';
import type { GameContext } from '@gaime/core/server';
import type { Command, Input, Player, World } from '../shared/types';
import { movePlayer, RULES } from '../shared/rules';
import type { BlankRegistry } from './registry';

export const SCHEMA = 1;

export function createWorld(): World {
  return { ...baseWorld(SCHEMA), pickups: {}, timers: {}, catalog: [] };
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

export function step(world: World, registry: BlankRegistry, inputs: Readonly<Record<string, Input>>, dt: number, ctx: GameContext<World>) {
  for (const player of Object.values(world.players)) {
    if (!player.online) continue;
    const input = inputs[player.id];
    if (input) movePlayer(player, input, dt);
    for (const pickup of Object.values(world.pickups)) {
      if (!circlesOverlap(player, RULES.playerRadius, pickup, RULES.pickupRadius)) continue;
      const def = registry.kinds.pickups[pickup.kind];
      delete world.pickups[pickup.id];
      if (!def) continue;
      player.score += def.value;
      def.onPickup?.(world, player);
    }
  }

  // `every` keeps its schedule in world.timers, so it survives checkpoints and hot reloads.
  if (Object.keys(world.pickups).length < RULES.maxPickups && every(world.timers, 'spawn', world.time, RULES.spawnEvery)) {
    const def = weighted(ctx.random, registry.lists.pickups, d => d.weight);
    if (def) {
      const id = `p${ctx.nextId()}`;
      const half = RULES.size / 2 - 1;
      world.pickups[id] = { id, kind: def.id, x: range(ctx.random, -half, half), z: range(ctx.random, -half, half) };
    }
  }
}

export function command(world: World, playerId: string, command: Command, ctx: GameContext<World>): string | void {
  if (command.type === 'reset-scores') {
    if (!ctx.isHost(playerId)) return 'Only the host can reset the scores.';
    for (const player of Object.values(world.players)) player.score = 0;
    ctx.log('Scores reset.');
    return;
  }
  return `Unknown command ${(command as { type: string }).type}.`;
}
