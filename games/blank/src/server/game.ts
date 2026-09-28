import { clamp } from '@gaime/core';
import { defineGame } from '@gaime/core/server';
import type { Command, Events, Input, Modifiers, Sim, World } from '../shared/types';
import { RULES } from '../shared/rules';
import { registry } from './registry';
import { botInput, collect, command, createPlayer, createWorld, makeSim, prepareWorld, spawn, step } from './simulation';

/**
 * How a tick runs (the engine does this, in this order):
 *   timers → `step` (inputs) → systems (`collect`, then `spawn` every RULES.spawnEvery s, then module systems)
 * and every event triggered along the way reaches the `on` handlers — the game's first, then the modules'.
 */
export const game = defineGame<World, Input, Sim, Events, Modifiers>({
  name: 'blank',
  network: {
    entities: ['players', 'pickups'],
    shared: ['catalog'],
    // Bus events clients also receive (the client plays a sound).
    events: ['pickup.collected'],
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
    { id: 'spawn', every: RULES.spawnEvery, run: spawn },
  ],
  on: {
    // Scoring is a reaction to the event, so modules can react to the same event too.
    'pickup.collected': ({ playerId, points }, sim) => {
      const player = sim.world.players[playerId];
      if (player) player.score += points;
    },
    'pickup.expired': ({ pickup }, sim) => { delete sim.world.pickups[pickup]; },
  },
  command: (world, playerId, payload, ctx) => command(world, playerId, payload as Command, ctx),
  bot: botInput,
});
