import { angleTo, baseWorld, dist, nearest } from '@gaime/core';
import { addEffect, freeColor, pointInRing, pointOnCircle, pruneEffects, raycast, rayEnd, separate, status, weighted } from '@gaime/core/kit';
import type { GameContext } from '@gaime/core/server';
import type { Command, Enemy, Input, Player, Sim, World } from '../shared/types';
import { clampToArena, movePlayer, RULES } from '../shared/rules';
import type { StarterRegistry } from './registry';

export const SCHEMA = 1;

export function createWorld(): World {
  return {
    ...baseWorld(SCHEMA),
    phase: 'lobby', wave: 0, nextWaveAt: 0, waveName: '',
    crystal: { hp: RULES.crystalHp, maxHp: RULES.crystalHp },
    score: 0, enemies: {}, spawns: [], effects: [], catalog: [],
  };
}

const CENTER = { x: 0, z: 0 };
const spawnPoint = (random: () => number) => pointInRing(random, CENTER, RULES.crystalRadius + 2, RULES.crystalRadius + 4);

export function createPlayer(world: World, id: string, name: string, random = Math.random): Player {
  const color = freeColor(Object.values(world.players).map(p => p.color), RULES.palette);
  return {
    id, name, online: true, data: {}, ...spawnPoint(random), angle: 0,
    hp: RULES.playerHp, maxHp: RULES.playerHp, color, respawnAt: 0, kills: 0,
    abilities: [...RULES.defaultAbilities], cooldowns: {}, nextShotAt: 0,
  };
}

/** Keeps the world consistent with the currently loaded features (after load and hot reload). */
export function prepareWorld(world: World, registry: StarterRegistry) {
  world.catalog = registry.catalog;
  const abilities = registry.kinds.abilities;
  const fallback = registry.lists.abilities.map(a => a.id);
  for (const player of Object.values(world.players)) {
    player.abilities = player.abilities.map((id, slot) => abilities[id] ? id : (RULES.defaultAbilities[slot] in abilities ? RULES.defaultAbilities[slot] : fallback[slot] ?? '')) as [string, string];
  }
  // A removed feature must not leave unknown enemies behind.
  for (const enemy of Object.values(world.enemies)) if (!registry.kinds.enemies[enemy.kind]) delete world.enemies[enemy.id];
  world.spawns = world.spawns.filter(spawn => registry.kinds.enemies[spawn.enemy]);
}

export function makeSim(world: World, registry: StarterRegistry, ctx: GameContext<World>, dt: number): Sim {
  const sim: Sim = {
    world, dt,
    random: ctx.random,
    enemies: () => Object.values(world.enemies),
    players: () => Object.values(world.players).filter(p => p.online && p.respawnAt === 0),
    nearestEnemy: (from, range = Infinity) => nearest(from, Object.values(world.enemies), range),
    nearestPlayer: (from, range = Infinity) => nearest(from, sim.players(), range),
    hurtEnemy(enemy, amount, byPlayerId) {
      if (!world.enemies[enemy.id] || !(amount > 0)) return;
      enemy.hp -= amount;
      if (enemy.hp > 0) return;
      delete world.enemies[enemy.id];
      const def = registry.kinds.enemies[enemy.kind];
      world.score += def?.reward ?? 0;
      const killer = byPlayerId ? world.players[byPlayerId] : undefined;
      if (killer) killer.kills++;
      sim.effect('hit', enemy, { radius: def?.radius ?? 1, color: def?.visual.color });
      def?.onDeath?.(sim, enemy, byPlayerId);
    },
    hurtPlayer(player, amount) {
      if (player.respawnAt || !(amount > 0)) return;
      player.hp -= amount;
      if (player.hp > 0) return;
      player.hp = 0;
      player.respawnAt = world.time + RULES.respawnSeconds;
      sim.effect('hit', player, { radius: 1.2, color: player.color });
      ctx.log(`${player.name} is down. Back in ${RULES.respawnSeconds} s.`);
      ctx.emit('sound', { kind: 'down' }, player.id);
    },
    hurtCrystal(amount) {
      if (world.phase !== 'fight' || !(amount > 0)) return;
      world.crystal.hp = Math.max(0, world.crystal.hp - amount);
    },
    heal(player, amount) {
      if (player.respawnAt || !(amount > 0)) return;
      player.hp = Math.min(player.maxHp, player.hp + amount);
    },
    spawn(enemy, options = {}) {
      if (!registry.kinds.enemies[enemy]) throw new Error(`Unknown enemy "${enemy}" — define it in the enemies of some feature.`);
      const count = Math.min(200, Math.max(1, Math.floor(options.count ?? 1)));
      for (let i = 0; i < count; i++) {
        const edge = pointOnCircle(ctx.random, CENTER, RULES.arenaRadius - 1.5);
        world.spawns.push({
          id: ctx.nextId(), enemy,
          at: world.time + (options.delay ?? 0) + i * (options.interval ?? 0.6),
          x: options.x ?? edge.x,
          z: options.z ?? edge.z,
        });
      }
    },
    slow(enemy, factor, seconds) {
      // The strongest active slow wins.
      const current = status.value(enemy.data, 'slow', world.time, 1);
      status.apply(enemy.data, 'slow', world.time, seconds, Math.max(0, Math.min(current, factor)));
    },
    moveTowards(entity, target, speed) {
      const d = dist(entity, target);
      if (d < 1e-6) return 0;
      const data = (entity as Partial<Enemy>).data;
      if (data) speed *= status.value(data, 'slow', world.time, 1);
      const step = Math.min(d, speed * dt);
      entity.angle = angleTo(entity, target);
      entity.x += ((target.x - entity.x) / d) * step;
      entity.z += ((target.z - entity.z) / d) * step;
      return d - step;
    },
    effect(type, at, options = {}) {
      addEffect(world.effects, ctx.nextId(), type, world.time, at, options);
    },
    log: ctx.log,
    emit: ctx.emit,
    enemyDef: kind => registry.kinds.enemies[kind],
    defaultAi(enemy) {
      const def = registry.kinds.enemies[enemy.kind];
      if (def) defaultAi(sim, enemy, def.speed, def.radius, def.damage);
    },
  };
  return sim;
}

// ── step ──────────────────────────────────────────────────────────────

export function step(world: World, registry: StarterRegistry, inputs: Readonly<Record<string, Input>>, dt: number, ctx: GameContext<World>) {
  const sim = makeSim(world, registry, ctx, dt);
  world.effects = pruneEffects(world.effects, world.time, RULES.effectSeconds);

  for (const player of Object.values(world.players)) {
    if (!player.online) continue;
    if (player.respawnAt) {
      if (world.time >= player.respawnAt) Object.assign(player, { ...spawnPoint(ctx.random), hp: player.maxHp, respawnAt: 0 });
      continue;
    }
    const input = inputs[player.id];
    if (!input) continue;
    movePlayer(player, input, dt);
    if (input.fire && world.phase !== 'lobby' && world.time >= player.nextShotAt) {
      player.nextShotAt = world.time + RULES.shotInterval;
      shoot(sim, player);
    }
  }

  if (world.phase === 'break' && world.time >= world.nextWaveAt) startWave(world, registry, sim, world.wave + 1);
  if (world.phase !== 'fight') return;

  for (const spawn of world.spawns.filter(s => s.at <= world.time)) {
    const def = registry.kinds.enemies[spawn.enemy];
    world.spawns.splice(world.spawns.indexOf(spawn), 1);
    if (!def) continue;
    const hp = Math.round(def.hp * (1 + 0.12 * (world.wave - 1)));
    const enemy: Enemy = { id: `e${spawn.id}`, kind: def.id, x: spawn.x, z: spawn.z, angle: angleTo(spawn, { x: 0, z: 0 }), hp, maxHp: hp, data: {} };
    world.enemies[enemy.id] = enemy;
    sim.effect('spawn', enemy, { radius: def.radius, color: def.visual.color });
  }

  const enemies = Object.values(world.enemies);
  for (const enemy of enemies) {
    if (!world.enemies[enemy.id]) continue;
    const def = registry.kinds.enemies[enemy.kind];
    if (!def) { delete world.enemies[enemy.id]; continue; }
    if (def.tick) def.tick(sim, enemy); else defaultAi(sim, enemy, def.speed, def.radius, def.damage);
  }
  separate(Object.values(world.enemies), enemy => registry.kinds.enemies[enemy.kind]?.radius ?? 0.5);

  if (world.crystal.hp <= 0) {
    world.phase = 'lost';
    world.spawns = [];
    ctx.log(`💥 The crystal fell on wave ${world.wave}. Score: ${world.score}. Anyone can start a NEW ROUND.`);
    ctx.emit('sound', { kind: 'lost' });
    return;
  }
  if (!world.spawns.length && !Object.keys(world.enemies).length) {
    const bonus = 50 * world.wave;
    world.score += bonus;
    world.phase = 'break';
    world.nextWaveAt = world.time + RULES.breakSeconds;
    ctx.log(`✅ Wave ${world.wave} repelled (+${bonus} pts). Next one in ${RULES.breakSeconds} s.`);
    ctx.emit('sound', { kind: 'cleared' });
  }
}

/** Walk to the closest player nearby, otherwise to the crystal; hurt whatever is touched. */
export function defaultAi(sim: Sim, enemy: Enemy, speed: number, radius: number, damage: number) {
  const player = sim.nearestPlayer(enemy, 7);
  const target = player ?? { x: 0, z: 0 };
  const reach = radius + (player ? RULES.playerRadius : RULES.crystalRadius) + 0.15;
  const gap = sim.moveTowards(enemy, target, speed);
  clampToArena(enemy, radius);
  if (gap > reach) return;
  if (player) sim.hurtPlayer(player, damage * sim.dt);
  else sim.hurtCrystal(damage * sim.dt);
}


/** Hitscan along the aim direction: the first enemy crossing the ray takes the hit. */
function shoot(sim: Sim, player: Player) {
  const hit = raycast(player, player.angle, RULES.shotRange, sim.enemies(), enemy => sim.enemyDef(enemy.kind)?.radius ?? 0.5);
  const end = hit?.point ?? rayEnd(player, player.angle, RULES.shotRange);
  sim.effect('tracer', player, { x2: end.x, z2: end.z, color: player.color });
  if (hit) sim.hurtEnemy(hit.item, RULES.shotDamage, player.id);
}

export function startWave(world: World, registry: StarterRegistry, sim: Sim, wave: number) {
  const eligible = registry.lists.waves.filter(w => (w.minWave ?? 1) <= wave);
  if (!eligible.length) { world.phase = 'lobby'; sim.log('No waves defined — add a feature with "waves".'); return; }
  const def = weighted(sim.random, eligible, w => w.weight ?? 1) ?? eligible[0];
  world.wave = wave;
  world.phase = 'fight';
  world.waveName = def.name;
  def.start(sim, wave);
  sim.log(`🌊 Wave ${wave}: ${def.name}`);
  sim.emit('sound', { kind: 'wave' });
}

export function resetRound(world: World, random: () => number) {
  Object.assign(world, { phase: 'lobby', wave: 0, waveName: '', nextWaveAt: 0, score: 0, enemies: {}, spawns: [], effects: [] });
  world.crystal = { hp: RULES.crystalHp, maxHp: RULES.crystalHp };
  for (const player of Object.values(world.players)) {
    Object.assign(player, { ...spawnPoint(random), hp: player.maxHp, respawnAt: 0, kills: 0, cooldowns: {}, nextShotAt: 0 });
  }
}

// ── commands ──────────────────────────────────────────────────────────

export function command(world: World, registry: StarterRegistry, playerId: string, command: Command, ctx: GameContext<World>): string | void {
  const player = world.players[playerId];
  if (!player) return;
  switch (command.type) {
    case 'start': {
      if (world.phase !== 'lobby' && world.phase !== 'lost') return 'A round is already running.';
      if (!ctx.isHost(playerId)) return 'The host (👑) starts the round.';
      resetRound(world, ctx.random);
      startWave(world, registry, makeSim(world, registry, ctx, 0), 1);
      return;
    }
    case 'restart': {
      if (world.phase !== 'lost') return 'A new round is available after a loss.';
      resetRound(world, ctx.random);
      ctx.log(`${player.name} started a new round.`);
      return;
    }
    case 'cast': {
      if (player.respawnAt) return;
      const slot = command.slot === 1 ? 1 : 0;
      const def = registry.kinds.abilities[player.abilities[slot]];
      if (!def) return 'No ability in this slot.';
      if ((player.cooldowns[def.id] ?? 0) > world.time) return;
      if (!Number.isFinite(command.x) || !Number.isFinite(command.z)) return;
      const target = { x: command.x, z: command.z };
      clampToArena(target, 0);
      player.cooldowns[def.id] = world.time + def.cooldown;
      def.cast(makeSim(world, registry, ctx, 0), player, target);
      return;
    }
    case 'equip': {
      const slot = command.slot === 1 ? 1 : 0;
      if (typeof command.ability !== 'string' || !registry.kinds.abilities[command.ability]) return 'Unknown ability.';
      const other = slot === 0 ? 1 : 0;
      if (player.abilities[other] === command.ability) player.abilities[other] = player.abilities[slot];
      player.abilities[slot] = command.ability;
      return;
    }
    default:
      return `Unknown command ${(command as { type: string }).type}.`;
  }
}


// ── bots ──────────────────────────────────────────────────────────────

/**
 * Brain of `/bot` players: stay near the crystal, face the closest enemy and shoot it,
 * use the first ability when enemies bunch up. Returns the same Input a client sends.
 */
export function botInput(world: World, id: string, ctx: GameContext<World>): Input | undefined {
  const bot = world.players[id];
  if (!bot || bot.respawnAt) return undefined;
  const target = nearest(bot, Object.values(world.enemies), RULES.shotRange);
  const home = pointOnCircle(() => (Number(bot.id.charCodeAt(4) ?? 0) % 16) / 16, CENTER, RULES.crystalRadius + 5);
  const goal = target && dist(bot, target) > RULES.shotRange * 0.7 ? target : home;
  const dx = goal.x - bot.x; const dz = goal.z - bot.z;
  const far = Math.hypot(dx, dz) > 1;
  if (target && Object.values(world.enemies).filter(enemy => dist(enemy, bot) < 6).length >= 4) {
    ctx.command(id, { type: 'cast', slot: 1, x: bot.x, z: bot.z });
  }
  return {
    mx: far ? dx / Math.hypot(dx, dz) : 0, mz: far ? dz / Math.hypot(dx, dz) : 0,
    ax: target?.x ?? bot.x + Math.sin(bot.angle), az: target?.z ?? bot.z + Math.cos(bot.angle),
    fire: !!target && world.phase === 'fight',
  };
}
