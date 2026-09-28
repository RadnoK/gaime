import { clamp } from '@gaime/core';
import { status } from '@gaime/core/kit';
import { defineGame } from '@gaime/core/server';
import type { Command, Events, Input, Modifiers, Sim, World } from '../shared/types';
import { registry } from './registry';
import {
  botInput, checkRound, command, createPlayer, createWorld, enemyAi, enterEnemy, makeSim, migrate,
  prepareWorld, pruneOldEffects, resetRound, respawnPlayer, separateEnemies, startWave, step,
} from './simulation';
import { tactics, threatInput } from './tactics';

/**
 * How a tick runs (the engine does this, in this order):
 *   due timers (`enemy.spawn`, `wave.start`, `player.respawn`) → `step` (movement, shooting)
 *   → update systems (`enemies`, then module systems) → late systems (`separate`, `round`, `effects`)
 * Every event triggered along the way reaches the `on` handlers — the game's first, then the modules'.
 */
export const game = defineGame<World, Input, Sim, Events, Modifiers>({
  name: 'starter',
  maxPlayers: 24,
  // Shared spatial indexes (ctx.near / ctx.nearest): rebuilt once per tick for every system and module.
  spatial: { enemies: { cell: 4 }, players: { cell: 8 } },
  network: {
    entities: ['players', 'enemies'],
    streams: ['feed', 'effects'],
    // The catalog is rebuilt from features on every load; never stored, sent only when it changes.
    shared: ['catalog'],
    // Bus events clients also receive (sounds, screen shake).
    events: ['wave.started', 'wave.cleared', 'player.downed', 'round.lost'],
  },
  features: registry,
  sim: (ctx, dt) => makeSim(registry, ctx, dt),
  createWorld,
  migrate,
  prepare: world => prepareWorld(world, registry),
  createPlayer: (world, id, name, ctx) => createPlayer(world, id, name, ctx.random),
  parseInput(raw): Input | undefined {
    const input = raw as Partial<Input> | null;
    if (!input || ![input.mx, input.mz, input.ax, input.az].every(Number.isFinite)) return undefined;
    return {
      mx: clamp(input.mx!, -1, 1), mz: clamp(input.mz!, -1, 1),
      ax: clamp(input.ax!, -100, 100), az: clamp(input.az!, -100, 100),
      fire: input.fire === true,
    };
  },
  step: (world, inputs, dt, ctx) => step(world, registry, inputs, dt, ctx),
  systems: [
    { id: 'enemies', run: sim => enemyAi(sim, registry) },
    { id: 'separate', phase: 'late', run: sim => separateEnemies(sim, registry) },
    { id: 'round', phase: 'late', run: checkRound },
    { id: 'effects', phase: 'late', run: pruneOldEffects },
  ],
  on: {
    'enemy.spawn': (spawn, sim) => enterEnemy(sim, registry, spawn),
    // Scoring is a reaction to the event, so modules can react to the same kill too.
    'enemy.died': ({ by, reward }, sim) => {
      sim.world.score += reward;
      const killer = by ? sim.world.players[by] : undefined;
      if (killer) killer.kills++;
    },
    'player.respawn': ({ playerId }, sim) => {
      if (respawnPlayer(sim.world, sim.random, playerId)) sim.trigger('player.respawned', { playerId });
    },
    'wave.start': ({ wave }, sim) => { if (sim.world.phase === 'break') startWave(sim, registry, wave); },
  },
  modify: {
    // `sim.slow` stores the strongest slow as a status in `enemy.data`; this applies it.
    'enemy.speed': (speed, { enemy }, sim) => {
      const data = sim.world.enemies[enemy]?.data;
      return data ? speed * status.value(data, 'slow', sim.world.time, 1) : speed;
    },
  },
  command: (world, playerId, payload, ctx) => command(world, registry, playerId, payload as Command, ctx),
  // `/bot` in chat (host) adds a teammate driven by this function.
  bot: botInput,

  // RPC: `net.request('scoreboard')` on the client.
  requests: {
    scoreboard: world => Object.values(world.players)
      .map(p => ({ name: p.name, kills: p.kills, online: p.online }))
      .sort((a, b) => b.kills - a.kills),
  },

  chat: {
    commands: {
      report: {
        description: 'threat analysis (computed in a worker, off the game loop)',
        run(world, _id, _args, ctx) {
          if (!Object.keys(world.enemies).length) return 'No enemies on the map.';
          const started = Date.now();
          ctx.job(tactics.run('threat', threatInput(world)), (_world, result) => {
            ctx.log(`📡 Report: biggest threat — ${result.sector} (x ${result.hottest.x.toFixed(0)}, z ${result.hottest.z.toFixed(0)}); ${result.cells} cells in ${Date.now() - started} ms.`);
          }, (_world, error) => ctx.log(`📡 Report failed: ${error.message}`));
          return 'Analysing…';
        },
      },
    },
  },

  // Operator commands: `gaime admin <name> [args]` in the game directory.
  admin: {
    spawn: {
      description: 'spawn <enemy> [count] — add enemies (also outside a wave)',
      run(world, [enemy, count], ctx) {
        if (world.phase !== 'fight') { world.phase = 'fight'; world.wave ||= 1; ctx.cancel('wave:next'); }
        makeSim(registry, ctx, 0).spawn(enemy, { count: Number(count) || 1, interval: 0.2 });
        return { queued: Number(count) || 1, enemy };
      },
    },
    wave: {
      description: 'wave <number> — start a wave right now',
      run(world, [wave], ctx) {
        if (world.phase === 'lost' || world.phase === 'lobby') resetRound(world, ctx);
        startWave(makeSim(registry, ctx, 0), registry, Math.max(1, Number(wave) || world.wave + 1));
        return { wave: world.wave, name: world.waveName };
      },
    },
    heal: {
      description: 'heal the crystal and every player',
      run(world, _args, ctx) {
        world.crystal.hp = world.crystal.maxHp;
        for (const player of Object.values(world.players)) {
          if (player.respawnAt) { ctx.cancel(`player:${player.id}:respawn`); respawnPlayer(world, ctx.random, player.id); }
          player.hp = player.maxHp;
        }
        return { ok: true };
      },
    },
  },
});
