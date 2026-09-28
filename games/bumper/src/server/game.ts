import { clamp } from '@gaime/core';
import { defineGame } from '@gaime/core/server';
import type { Command, Events, Input, Modifiers, Sim, World } from '../shared/types';
import { RULES } from '../shared/rules';
import { physics } from './physics';
import { registry } from './registry';
import {
  botInput, collect, command, createPlayer, createWorld, makeSim, onContact, onKnocked, onRespawn, onRoundWon, prepareWorld,
  referee, ringOut, runMatch, shrink, spawn, step, updateMass,
} from './simulation';

/**
 * How a tick runs (the engine does this, in this order):
 *   timers → `match` (input phase) → `step` (steering) → `mass` → `physics` (Rapier; contacts
 *   become `physics.contact`) → `ring-out` → `collect` → `shrink` → `spawn` (every RULES.spawnEvery s)
 *   → module systems → `referee` (late)
 * and every event triggered along the way reaches the `on` handlers — the game's first, then the modules'.
 */
export const game = defineGame<World, Input, Sim, Events, Modifiers>({
  name: 'bumper',
  // A round game: leaving frees the place (and the disc).
  keepPlayers: false,
  // Many small arenas instead of one: up to 6 players per room, a new room when they are full,
  // invite codes for private games (docs/ROOMS.md). A running round is locked against newcomers.
  rooms: { mode: 'matches', size: 6 },
  network: {
    entities: ['players', 'pickups'],
    shared: ['catalog'],
    precision: { spin: 10, mass: 10, arena: 100 },
    // Bus events clients also receive (sounds, screen shake).
    events: ['player.bumped', 'player.knocked', 'dash.used', 'round.countdown', 'round.started', 'round.won', 'pickup.collected'],
  },
  // `ctx.nearest('players', …)` for the bots.
  spatial: { players: { cell: 4 } },
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
  step: (world, inputs, dt, _ctx, sim) => step(world, inputs, dt, sim),
  systems: [
    { id: 'match', phase: 'input', run: runMatch },
    { id: 'mass', run: updateMass },
    physics.system<Sim>(),
    { id: 'ring-out', run: ringOut },
    { id: 'collect', run: sim => collect(sim, registry) },
    { id: 'shrink', run: shrink },
    { id: 'spawn', every: RULES.spawnEvery, run: spawn },
    { id: 'referee', phase: 'late', run: referee },
  ],
  on: {
    'physics.contact': onContact,
    'player.knocked': onKnocked,
    'player.respawn': onRespawn,
    // Scoring is a reaction to the event, so modules can react to the same event too.
    'round.won': (event, sim) => { onRoundWon(event, sim); sim.lockRoom(false); },
    'round.started': (_event, sim) => { sim.lockRoom(true); },
    // A real disconnect during a round counts as falling off.
    'player.offline': ({ player }, sim) => { if (sim.world.match.phase === 'playing') sim.knockOut(player); },
  },
  command: (world, playerId, payload, ctx) => command(world, playerId, payload as Command, ctx),
  bot: botInput,
});
