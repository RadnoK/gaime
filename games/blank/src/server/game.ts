import { clamp } from '@gaime/core';
import { defineGame } from '@gaime/core/server';
import type { Command, Input, World } from '../shared/types';
import { registry } from './registry';
import { command, createPlayer, createWorld, prepareWorld, step } from './simulation';

export const game = defineGame<World, Input>({
  name: 'blank',
  network: {
    entities: ['players', 'pickups'],
    shared: ['catalog'],
    // Server-only state stays off the wire.
    hidden: ['timers'],
  },
  createWorld,
  prepare: world => prepareWorld(world, registry),
  createPlayer: (world, id, name, ctx) => createPlayer(world, id, name, ctx.random),
  parseInput(raw) {
    const input = raw as Partial<Input> | null;
    if (!input || !Number.isFinite(input.mx) || !Number.isFinite(input.mz)) return undefined;
    return { mx: clamp(input.mx!, -1, 1), mz: clamp(input.mz!, -1, 1) };
  },
  step: (world, inputs, dt, ctx) => step(world, registry, inputs, dt, ctx),
  command: (world, playerId, payload, ctx) => command(world, playerId, payload as Command, ctx),
  // `/bot` in chat: a bot that walks to the nearest pickup.
  bot(world, id) {
    const bot = world.players[id];
    const target = Object.values(world.pickups).sort((a, b) => Math.hypot(a.x - bot.x, a.z - bot.z) - Math.hypot(b.x - bot.x, b.z - bot.z))[0];
    if (!target) return { mx: 0, mz: 0 };
    const d = Math.hypot(target.x - bot.x, target.z - bot.z) || 1;
    return { mx: (target.x - bot.x) / d, mz: (target.z - bot.z) / d };
  },
});
