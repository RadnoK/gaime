import { addTimer, angleTo, baseWorld, dist, nearest } from '@gaime/core';
import { addEffect, freeColor, pointInRing, pointOnCircle, pruneEffects, raycast, rayEnd, separateWith, status, weighted } from '@gaime/core/kit';
import type { GameContext } from '@gaime/core/server';
import type { Command, Enemy, Events, Input, Player, Sim, World } from '../shared/types';
import { clampToArena, movePlayer, RULES } from '../shared/rules';
import type { StarterRegistry } from './registry';

/** 2: pending spawns moved from `world.spawns` to timers; respawns and breaks are timers too. */
export const SCHEMA = 2;
type Ctx = GameContext<World, Events>;

export function createWorld(): World {
  return {
    ...baseWorld(SCHEMA),
    phase: 'lobby', wave: 0, nextWaveAt: 0, waveName: '',
    crystal: { hp: RULES.crystalHp, maxHp: RULES.crystalHp },
    score: 0, enemies: {}, effects: [], catalog: [],
  };
}

const CENTER = { x: 0, z: 0 };
const spawnPoint = (random: () => number) => pointInRing(random, CENTER, RULES.crystalRadius + 2, RULES.crystalRadius + 4);
const respawnKey = (playerId: string) => `player:${playerId}:respawn`;

export function createPlayer(world: World, id: string, name: string, random = Math.random): Player {
  const color = freeColor(Object.values(world.players).map(p => p.color), RULES.palette);
  return {
    id, name, online: true, data: {}, ...spawnPoint(random), angle: 0,
    hp: RULES.playerHp, maxHp: RULES.playerHp, color, respawnAt: 0, kills: 0,
    abilities: [...RULES.defaultAbilities], cooldowns: {}, nextShotAt: 0,
  };
}

/**
 * Upgrades older saves (checkpoints and the hot-reload cache). Schema 1 polled `world.spawns`,
 * `player.respawnAt` and `world.nextWaveAt` every tick; schema 2 keeps them as timers.
 */
export function migrate(world: World): World {
  if (world.schema < 2) {
    const old = world as World & { spawns?: Array<{ id?: unknown; enemy?: unknown; at?: unknown; x?: unknown; z?: unknown }> };
    const now = world.time;
    for (const spawn of Array.isArray(old.spawns) ? old.spawns : []) {
      const { id, enemy, at, x, z } = spawn ?? {};
      if (typeof enemy !== 'string' || ![id, at, x, z].every(Number.isFinite)) continue;
      addTimer(world.schedule, now, (at as number) - now, 'enemy.spawn', { id: `e${id}`, kind: enemy, x: x as number, z: z as number }, { key: `spawn:${id}` });
    }
    delete old.spawns;
    for (const player of Object.values(world.players)) {
      if (player.respawnAt > 0) addTimer(world.schedule, now, player.respawnAt - now, 'player.respawn', { playerId: player.id }, { key: respawnKey(player.id) });
    }
    if (world.phase === 'break') addTimer(world.schedule, now, world.nextWaveAt - now, 'wave.start', { wave: world.wave + 1 }, { key: 'wave:next' });
    world.schema = 2;
  }
  return world;
}

/** Keeps the world consistent with the currently loaded features (after load and hot reload). */
export function prepareWorld(world: World, registry: StarterRegistry) {
  world.catalog = registry.catalog;
  const abilities = registry.kinds.abilities;
  const fallback = registry.lists.abilities.map(a => a.id);
  for (const player of Object.values(world.players)) {
    player.abilities = player.abilities.map((id, slot) => abilities[id] ? id : (RULES.defaultAbilities[slot] in abilities ? RULES.defaultAbilities[slot] : fallback[slot] ?? '')) as [string, string];
  }
  // A removed feature must not leave unknown enemies behind (their spawn timers are ignored when they fire).
  for (const enemy of Object.values(world.enemies)) if (!registry.kinds.enemies[enemy.kind]) delete world.enemies[enemy.id];
}

/** The facade module code works with: built once per tick by the engine (`GameDefinition.sim`), and per command. */
export function makeSim(registry: StarterRegistry, ctx: Ctx, dt: number): Sim {
  const world = ctx.world;
  const owner = (kind: string, id: string) => registry.owner[`${kind}/${id}`];
  const sim: Sim = {
    world, dt,
    random: ctx.random,
    trigger: (event: string, data?: unknown) => ctx.trigger(event as `${string}:${string}`, data),
    after: (seconds: number, event: string, data?: unknown, options?: { key?: string }) => { ctx.after(seconds, event as `${string}:${string}`, data, options); },
    cancel: (key, options) => ctx.cancel(key, options),
    timeLeft: key => ctx.timeLeft(key),
    timers: prefix => ctx.timers(prefix),
    modify: (name, value, data) => ctx.modify(name, value, data),
    isolate: (module, run) => ctx.isolate(module, run),
    disabled: module => ctx.disabled(module),
    enemies: () => Object.values(world.enemies),
    players: () => Object.values(world.players).filter(p => p.online && p.respawnAt === 0),
    // The engine's shared spatial index (GameDefinition.spatial): one rebuild per tick for everyone.
    nearestEnemy: (from, range) => ctx.nearest<Enemy>('enemies', from, range),
    nearestPlayer: (from, range) => ctx.nearest<Player>('players', from, range, p => p.online && p.respawnAt === 0),
    enemiesNear: (at, radius) => ctx.near<Enemy>('enemies', at, radius),
    hurtEnemy(enemy, amount, byPlayerId, source = 'shot') {
      if (world.enemies[enemy.id] !== enemy || !(amount > 0)) return;
      const by = byPlayerId && world.players[byPlayerId] ? { by: byPlayerId } : {};
      enemy.hp -= ctx.modify('enemy.damage', amount, { enemy: enemy.id, kind: enemy.kind, source, ...by });
      if (enemy.hp > 0) return;
      delete world.enemies[enemy.id];
      ctx.cancel(`enemy:${enemy.id}:`, { prefix: true });
      const def = registry.kinds.enemies[enemy.kind];
      const reward = Math.max(0, ctx.modify('enemy.reward', def?.reward ?? 0, { enemy: enemy.id, kind: enemy.kind, ...by }));
      sim.effect('hit', enemy, { radius: def?.radius ?? 1, color: def?.visual.color });
      if (def?.onDeath) ctx.isolate(owner('enemies', def.id), () => def.onDeath!(sim, enemy, byPlayerId));
      // Score and kills: the game's `on['enemy.died']` (modules can react to the same event).
      ctx.trigger('enemy.died', { enemy: enemy.id, kind: enemy.kind, x: enemy.x, z: enemy.z, reward, ...by });
    },
    hurtPlayer(player, amount, source = 'enemy') {
      if (player.respawnAt || !(amount > 0)) return;
      player.hp -= ctx.modify('player.damage', amount, { playerId: player.id, source });
      if (player.hp > 0) return;
      player.hp = 0;
      player.respawnAt = world.time + RULES.respawnSeconds;
      ctx.after(RULES.respawnSeconds, 'player.respawn', { playerId: player.id }, { key: respawnKey(player.id) });
      sim.effect('hit', player, { radius: 1.2, color: player.color });
      ctx.log(`${player.name} is down. Back in ${RULES.respawnSeconds} s.`);
      ctx.trigger('player.downed', { playerId: player.id, x: player.x, z: player.z });
    },
    hurtCrystal(amount, source = 'enemy') {
      if (world.phase !== 'fight' || !(amount > 0)) return;
      world.crystal.hp = Math.max(0, world.crystal.hp - ctx.modify('crystal.damage', amount, { source }));
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
        const id = ctx.nextId();
        const at = { x: options.x ?? edge.x, z: options.z ?? edge.z };
        // Pending enemies are timers: the wave is cleared when no enemy and no `spawn:` timer is left.
        ctx.after(Math.max(0, (options.delay ?? 0) + i * (options.interval ?? 0.6)), 'enemy.spawn', { id: `e${id}`, kind: enemy, ...at }, { key: `spawn:${id}` });
      }
    },
    slow(enemy, factor, seconds) {
      // The strongest active slow wins; the game's `modify['enemy.speed']` applies it.
      const current = status.value(enemy.data, 'slow', world.time, 1);
      status.apply(enemy.data, 'slow', world.time, seconds, Math.max(0, Math.min(current, factor)));
    },
    enemySpeed(enemy) {
      const def = registry.kinds.enemies[enemy.kind];
      return Math.max(0, ctx.modify('enemy.speed', def?.speed ?? 0, { enemy: enemy.id, kind: enemy.kind }));
    },
    moveTowards(entity, target, speed) {
      const d = dist(entity, target);
      if (d < 1e-6) return 0;
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
      if (def) defaultAi(sim, enemy, sim.enemySpeed(enemy), def.radius, def.damage);
    },
  };
  return sim;
}

// ── tick: step (inputs) and systems ─────────────────────────────────────

/** Input handling: movement and shooting of every living, online player. */
export function step(world: World, registry: StarterRegistry, inputs: Readonly<Record<string, Input>>, dt: number, ctx: Ctx) {
  let sim: Sim | undefined;
  for (const player of Object.values(world.players)) {
    const input = inputs[player.id];
    if (!player.online || player.respawnAt || !input) continue;
    movePlayer(player, input, dt);
    if (input.fire && world.phase !== 'lobby' && world.time >= player.nextShotAt) {
      player.nextShotAt = world.time + RULES.shotInterval;
      shoot(sim ??= makeSim(registry, ctx, dt), player);
    }
  }
}

/** System: every enemy acts — its module's `tick`, or the default AI (also when that module is switched off). */
export function enemyAi(sim: Sim, registry: StarterRegistry) {
  if (sim.world.phase !== 'fight') return;
  for (const enemy of Object.values(sim.world.enemies)) {
    if (sim.world.enemies[enemy.id] !== enemy) continue;
    const def = registry.kinds.enemies[enemy.kind];
    if (!def) { delete sim.world.enemies[enemy.id]; continue; }
    if (def.tick && sim.isolate(registry.owner[`enemies/${def.id}`], () => { def.tick!(sim, enemy); return true; })) continue;
    defaultAi(sim, enemy, sim.enemySpeed(enemy), def.radius, def.damage);
  }
}

/** System (late): enemies push each other apart. */
/** Largest enemy radius any module may define (the neighbour search reaches this far). */
const MAX_ENEMY_RADIUS = 2.5;

export function separateEnemies(sim: Sim, registry: StarterRegistry) {
  // Neighbours from the spatial index: O(n·k) instead of every pair, so big waves stay cheap.
  const radius = (enemy: Enemy) => registry.kinds.enemies[enemy.kind]?.radius ?? 0.5;
  separateWith(Object.values(sim.world.enemies), radius, enemy => sim.enemiesNear(enemy, radius(enemy) + MAX_ENEMY_RADIUS));
}

/** System (late): the round ends when the crystal falls; a wave is cleared when nothing is left, alive or scheduled. */
export function checkRound(sim: Sim) {
  const world = sim.world;
  if (world.phase !== 'fight') return;
  if (world.crystal.hp <= 0) {
    world.phase = 'lost';
    sim.cancel('spawn:', { prefix: true });
    sim.log(`💥 The crystal fell on wave ${world.wave}. Score: ${world.score}. Anyone can start a NEW ROUND.`);
    sim.trigger('round.lost', { wave: world.wave, score: world.score });
    return;
  }
  if (Object.keys(world.enemies).length || sim.timers('spawn:')) return;
  const bonus = 50 * world.wave;
  world.score += bonus;
  world.phase = 'break';
  world.nextWaveAt = world.time + RULES.breakSeconds;
  sim.after(RULES.breakSeconds, 'wave.start', { wave: world.wave + 1 }, { key: 'wave:next' });
  sim.log(`✅ Wave ${world.wave} repelled (+${bonus} pts). Next one in ${RULES.breakSeconds} s.`);
  sim.trigger('wave.cleared', { wave: world.wave, bonus });
}

/** System (late): drop finished visual effects. */
export function pruneOldEffects(sim: Sim) {
  sim.world.effects = pruneEffects(sim.world.effects, sim.world.time, RULES.effectSeconds);
}

/** Walk to the closest player nearby, otherwise to the crystal; hurt whatever is touched. */
export function defaultAi(sim: Sim, enemy: Enemy, speed: number, radius: number, damage: number) {
  const player = sim.nearestPlayer(enemy, 7);
  const target = player ?? { x: 0, z: 0 };
  const reach = radius + (player ? RULES.playerRadius : RULES.crystalRadius) + 0.15;
  const gap = sim.moveTowards(enemy, target, speed);
  clampToArena(enemy, radius);
  if (gap > reach) return;
  if (player) sim.hurtPlayer(player, damage * sim.dt, enemy.kind);
  else sim.hurtCrystal(damage * sim.dt, enemy.kind);
}

/** Hitscan along the aim direction: the first enemy crossing the ray takes the hit. */
function shoot(sim: Sim, player: Player) {
  const hit = raycast(player, player.angle, RULES.shotRange, sim.enemies(), enemy => sim.enemyDef(enemy.kind)?.radius ?? 0.5);
  const end = hit?.point ?? rayEnd(player, player.angle, RULES.shotRange);
  sim.effect('tracer', player, { x2: end.x, z2: end.z, color: player.color });
  if (hit) sim.hurtEnemy(hit.item, RULES.shotDamage, player.id, 'shot');
}

// ── event handlers (the game's `on`) ────────────────────────────────────

/** `enemy.spawn` timer: the enemy enters (only while fighting; a removed module's enemies are skipped). */
export function enterEnemy(sim: Sim, registry: StarterRegistry, { id, kind, x, z }: Events['enemy.spawn']) {
  const world = sim.world;
  const def = registry.kinds.enemies[kind];
  if (world.phase !== 'fight' || !def || world.enemies[id]) return;
  const hp = Math.max(1, Math.round(sim.modify('enemy.hp', def.hp * (1 + 0.12 * (world.wave - 1)), { kind, wave: world.wave })));
  world.enemies[id] = { id, kind, x, z, angle: angleTo({ x, z }, CENTER), hp, maxHp: hp, data: {} };
  sim.effect('spawn', { x, z }, { radius: def.radius, color: def.visual.color });
  sim.trigger('enemy.spawned', { enemy: id, kind, x, z });
}

export function respawnPlayer(world: World, random: () => number, playerId: string): boolean {
  const player = world.players[playerId];
  if (!player || !player.respawnAt) return false;
  Object.assign(player, { ...spawnPoint(random), hp: player.maxHp, respawnAt: 0 });
  return true;
}

/**
 * Picks an eligible attack and runs its `start` (isolated: a failing module is switched off and
 * another attack is tried). No attack left → back to the lobby.
 */
export function startWave(sim: Sim, registry: StarterRegistry, wave: number) {
  const world = sim.world;
  sim.cancel('wave:next');
  const eligible = registry.lists.waves.filter(w => (w.minWave ?? 1) <= wave);
  world.wave = wave;
  world.phase = 'fight';
  while (eligible.length) {
    const candidates = eligible.filter(w => !sim.disabled(registry.owner[`waves/${w.id}`]));
    const def = weighted(sim.random, candidates, w => w.weight ?? 1) ?? candidates[0];
    if (!def) break;
    eligible.splice(eligible.indexOf(def), 1);
    world.waveName = def.name;
    if (!sim.isolate(registry.owner[`waves/${def.id}`], () => { def.start(sim, wave); return true; })) continue;
    sim.log(`🌊 Wave ${wave}: ${def.name}`);
    sim.trigger('wave.started', { wave, attack: def.id, name: def.name });
    return;
  }
  world.phase = 'lobby';
  world.waveName = '';
  sim.log('No waves available — add a feature with "waves".');
}

export function resetRound(world: World, ctx: Ctx) {
  Object.assign(world, { phase: 'lobby', wave: 0, waveName: '', nextWaveAt: 0, score: 0, enemies: {}, effects: [] });
  world.crystal = { hp: RULES.crystalHp, maxHp: RULES.crystalHp };
  ctx.cancel('spawn:', { prefix: true });
  ctx.cancel('enemy:', { prefix: true });
  ctx.cancel('wave:next');
  for (const player of Object.values(world.players)) {
    ctx.cancel(respawnKey(player.id));
    Object.assign(player, { ...spawnPoint(ctx.random), hp: player.maxHp, respawnAt: 0, kills: 0, cooldowns: {}, nextShotAt: 0 });
  }
}

// ── commands ──────────────────────────────────────────────────────────

export function command(world: World, registry: StarterRegistry, playerId: string, command: Command, ctx: Ctx): string | void {
  const player = world.players[playerId];
  if (!player) return;
  switch (command.type) {
    case 'start': {
      if (world.phase !== 'lobby' && world.phase !== 'lost') return 'A round is already running.';
      if (!ctx.isHost(playerId)) return 'The host (👑) starts the round.';
      resetRound(world, ctx);
      startWave(makeSim(registry, ctx, 0), registry, 1);
      return;
    }
    case 'restart': {
      if (world.phase !== 'lost') return 'A new round is available after a loss.';
      resetRound(world, ctx);
      ctx.log(`${player.name} started a new round.`);
      return;
    }
    case 'cast': {
      if (player.respawnAt) return;
      const slot = command.slot === 1 ? 1 : 0;
      const def = registry.kinds.abilities[player.abilities[slot]];
      if (!def) return 'No ability in this slot.';
      const owner = registry.owner[`abilities/${def.id}`];
      if (ctx.disabled(owner)) return `${def.name} is switched off after an error in module ${owner}.`;
      if ((player.cooldowns[def.id] ?? 0) > world.time) return;
      if (!Number.isFinite(command.x) || !Number.isFinite(command.z)) return;
      const target = { x: command.x, z: command.z };
      clampToArena(target, 0);
      const sim = makeSim(registry, ctx, 0);
      player.cooldowns[def.id] = world.time + Math.max(0, sim.modify('ability.cooldown', def.cooldown, { playerId, ability: def.id }));
      if (!sim.isolate(owner, () => { def.cast(sim, player, target); return true; })) return `${def.name} failed and was switched off.`;
      sim.trigger('ability.cast', { playerId, ability: def.id, x: target.x, z: target.z });
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
 * use the second ability when enemies bunch up. Returns the same Input a client sends.
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
