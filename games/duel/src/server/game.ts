import { clamp } from '@gaime/core';
import { defineGame } from '@gaime/core/server';
import type { Command, Input, World } from '../shared/types';
import { registry } from './registry';
import { botInput, command, createPlayer, createWorld, onPlayerOnline, prepareWorld, step } from './simulation';

export const game = defineGame<World, Input>({
  name: 'duel',
  // Two seats plus spectators; leaving frees the seat (a duel is not a persistent world).
  keepPlayers: false,
  maxPlayers: 8,
  network: {
    entities: ['players', 'projectiles'],
    streams: ['feed', 'effects'],
    shared: ['catalog'],
    precision: { aim: 1, hp: 1 },
  },
  createWorld,
  prepare: world => prepareWorld(world, registry),
  createPlayer: (world, id, name) => createPlayer(world, id, name),
  onPlayerOnline,
  parseInput(raw) {
    const input = raw as Partial<Input> | null;
    if (!input || !Number.isFinite(input.move) || !Number.isFinite(input.aim)) return undefined;
    return { move: clamp(input.move!, -1, 1), aim: clamp(input.aim!, 0, 180) };
  },
  step: (world, inputs, dt, ctx) => step(world, registry, inputs, dt, ctx),
  command: (world, playerId, payload, ctx) => command(world, registry, playerId, payload as Command, ctx),
  // `/bot` in chat: play against the computer.
  bot: (world, id, ctx) => botInput(world, id, ctx, registry),
});
