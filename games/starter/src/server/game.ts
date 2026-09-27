import { clamp } from '@gaime/core';
import { defineGame } from '@gaime/core/server';
import type { Command, Input, World } from '../shared/types';
import { registry } from './registry';
import { command, createPlayer, createWorld, makeSim, prepareWorld, resetRound, startWave, step } from './simulation';
import { tactics, threatInput } from './tactics';

export const game = defineGame<World, Input>({
  name: 'starter',
  maxPlayers: 24,
  network: {
    entities: ['players', 'enemies'],
    streams: ['feed', 'effects'],
    // The catalog is rebuilt from features on every load; never stored, sent only when it changes.
    shared: ['catalog'],
    hidden: ['spawns'],
  },
  createWorld,
  migrate(world) {
    // Schema 1 is the first version. When the World shape changes incompatibly,
    // bump SCHEMA in simulation.ts and upgrade older saves here, e.g.:
    // if (world.schema === 1) { ...; world.schema = 2; }
    return world;
  },
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
  command: (world, playerId, payload, ctx) => command(world, registry, playerId, payload as Command, ctx),

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
        if (world.phase !== 'fight') { world.phase = 'fight'; world.wave ||= 1; }
        makeSim(world, registry, ctx, 0).spawn(enemy, { count: Number(count) || 1, interval: 0.2 });
        return { queued: Number(count) || 1, enemy };
      },
    },
    wave: {
      description: 'wave <number> — start a wave right now',
      run(world, [wave], ctx) {
        if (world.phase === 'lost' || world.phase === 'lobby') resetRound(world, ctx.random);
        startWave(world, registry, makeSim(world, registry, ctx, 0), Math.max(1, Number(wave) || world.wave + 1));
        return { wave: world.wave, name: world.waveName };
      },
    },
    heal: {
      description: 'heal the crystal and every player',
      run(world) {
        world.crystal.hp = world.crystal.maxHp;
        for (const player of Object.values(world.players)) { player.hp = player.maxHp; player.respawnAt = 0; }
        return { ok: true };
      },
    },
  },
});
