import { clamp } from '@gaime/core';
import { defineGame } from '@gaime/core/server';
import type { Command, Events, Input, Modifiers, Sim, World } from '../shared/types';
import { registry } from './registry';
import {
  botInput, command, createPlayer, createWorld, expireTurn, fadeEffects, fall, impact, makeSim, migrate, moveShells,
  onPlayerOnline, prepareWorld, referee, resolveShots, runMatch, step,
} from './simulation';

/**
 * How a tick runs (the engine does this, in this order):
 *   timers (`turn:end` → `turn.expired`) → `match` (input phase) → `step` (walk, aim)
 *   → `fall` → `shells` (impacts trigger `shell.impact`) → `referee` → `turns` → module systems → `effects` (late)
 * and every event triggered along the way reaches the `on` handlers — the game's first, then the modules'.
 */
export const game = defineGame<World, Input, Sim, Events, Modifiers>({
  name: 'duel',
  // Two seats plus spectators; leaving frees the seat (a duel is not a persistent world).
  keepPlayers: false,
  maxPlayers: 8,
  network: {
    entities: ['players', 'projectiles'],
    streams: ['feed', 'effects'],
    shared: ['catalog'],
    precision: { aim: 1, hp: 1 },
    // Bus events clients also receive (sounds, screen shake).
    events: ['match.countdown', 'match.started', 'match.ended', 'turn.started', 'shell.fired', 'shell.exploded', 'player.hit'],
  },
  features: registry,
  sim: (ctx, dt) => makeSim(registry, ctx, dt),
  createWorld,
  migrate,
  prepare: (world, ctx) => prepareWorld(world, registry, ctx),
  createPlayer: (world, id, name) => createPlayer(world, id, name),
  onPlayerOnline: (world, player, online, ctx) => onPlayerOnline(world, player, online, ctx, registry),
  parseInput(raw) {
    const input = raw as Partial<Input> | null;
    if (!input || !Number.isFinite(input.move) || !Number.isFinite(input.aim)) return undefined;
    return { move: clamp(input.move!, -1, 1), aim: clamp(input.aim!, 0, 180) };
  },
  step,
  systems: [
    { id: 'match', phase: 'input', run: sim => runMatch(sim, registry) },
    { id: 'fall', run: fall },
    { id: 'shells', run: sim => moveShells(sim, registry) },
    { id: 'referee', run: referee },
    // After `shells` dispatched its impacts, so bomblets launched by handlers count as in flight.
    { id: 'turns', run: resolveShots },
    { id: 'effects', phase: 'late', run: fadeEffects },
  ],
  on: {
    // Explosions are a reaction to the impact, so modules can react to the same impact too.
    'shell.impact': (event, sim) => impact(event, sim, registry),
    'turn.expired': ({ turn }, sim) => expireTurn(turn, sim),
  },
  command: (world, playerId, payload, ctx) => command(world, registry, playerId, payload as Command, ctx),
  // `/bot` in chat: play against the computer.
  bot: (world, id, ctx) => botInput(world, id, ctx, registry),
});
