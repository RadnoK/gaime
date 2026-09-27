import { baseWorld, clamp } from '@gaime/core';
import {
  ballisticAngle, createMatch, createTurns, endMatch, freezeTurn, isTurnOf, launch, nextTurn, range,
  pruneEffects, addEffect, resumeTurn, setReady, stepMatch, stepProjectiles, toLobby, turnExpired, turnTimeLeft,
} from '@gaime/core/kit';
import type { GameContext } from '@gaime/core/server';
import type { Command, Input, Player, Sim, World } from '../shared/types';
import { carve, generateTerrain, heightAt, muzzle, RULES } from '../shared/rules';
import { DEFAULT_WEAPON, type DuelRegistry } from './registry';

export const SCHEMA = 1;

export function createWorld(): World {
  return {
    ...baseWorld(SCHEMA),
    match: createMatch(), turns: null, terrain: generateTerrain(1), wind: 0,
    projectiles: {}, effects: [], shotFired: false, retreatUntil: 0, catalog: [],
  };
}

/** The two seated players, left first. */
export function fighters(world: World): Player[] {
  return Object.values(world.players).filter(p => p.seat >= 0).sort((a, b) => a.seat - b.seat);
}

export function createPlayer(world: World, id: string, name: string): Player {
  const taken = new Set(fighters(world).map(p => p.seat));
  const seat = !taken.has(0) ? 0 : !taken.has(1) ? 1 : -1;
  const x = seat === 1 ? RULES.spawnX : -RULES.spawnX;
  return {
    id, name, online: true, data: {}, seat, x, z: heightAt(world.terrain, x), vz: 0,
    facing: seat === 1 ? -1 : 1, aim: seat === 1 ? 135 : 45, hp: RULES.hp, wins: 0,
    weapon: DEFAULT_WEAPON, ammo: {},
  };
}

export function prepareWorld(world: World, registry: DuelRegistry) {
  world.catalog = registry.catalog;
  for (const player of Object.values(world.players)) if (!registry.kinds.weapons[player.weapon]) player.weapon = DEFAULT_WEAPON;
  for (const projectile of Object.values(world.projectiles)) if (!registry.kinds.weapons[projectile.kind]) delete world.projectiles[projectile.id];
}

export function makeSim(world: World, registry: DuelRegistry, ctx: GameContext<World>): Sim {
  const sim: Sim = {
    world,
    random: ctx.random,
    heightAt: x => heightAt(world.terrain, x),
    explode(at, radius, damage, byPlayerId) {
      carve(world.terrain, at, radius);
      addEffect(world.effects, ctx.nextId(), 'explosion', world.time, at, { radius, color: '#ff8a3d' });
      ctx.emit('sound', { kind: 'boom' });
      for (const player of fighters(world)) {
        const d = Math.hypot(player.x - at.x, player.z + 0.8 - at.z);
        if (d > radius + RULES.playerRadius || player.hp <= 0) continue;
        const hit = Math.round(damage * (1 - Math.min(1, d / (radius + RULES.playerRadius)) * 0.7));
        player.hp = Math.max(0, player.hp - hit);
        addEffect(world.effects, ctx.nextId(), 'text', world.time, player, { text: `-${hit}`, color: player.id === byPlayerId ? '#ffd659' : '#ff5977', y: 3 });
      }
      // Craters can take the ground away: let players fall.
      for (const player of fighters(world)) if (player.z > heightAt(world.terrain, player.x)) player.vz = Math.min(player.vz, 0);
      // Array identity changes, so the patch sends the terrain once per explosion.
      world.terrain = [...world.terrain];
    },
    launch(weapon, from, angleDegrees, speed, owner) {
      const id = `s${ctx.nextId()}`;
      // Kit angles are measured from +Z (our "up"); weapon angles from +X.
      world.projectiles[id] = launch({ id, kind: weapon, owner, from, angle: ((90 - angleDegrees) * Math.PI) / 180, speed, radius: 0.25, life: 12, time: world.time });
    },
    log: ctx.log,
    emit: (name, data) => ctx.emit(name, data),
  };
  return sim;
}

function startRound(world: World, registry: DuelRegistry, ctx: GameContext<World>) {
  world.terrain = generateTerrain(Math.floor(ctx.random() * 1e9));
  world.projectiles = {};
  world.effects = [];
  world.shotFired = false;
  world.retreatUntil = 0;
  for (const player of fighters(world)) {
    player.x = player.seat === 1 ? RULES.spawnX : -RULES.spawnX;
    player.z = heightAt(world.terrain, player.x);
    Object.assign(player, { vz: 0, hp: RULES.hp, facing: player.seat === 1 ? -1 : 1, aim: player.seat === 1 ? 135 : 45 });
    player.ammo = Object.fromEntries(registry.lists.weapons.filter(w => w.ammo !== undefined).map(w => [w.id, w.ammo!]));
    if (!registry.kinds.weapons[player.weapon]) player.weapon = DEFAULT_WEAPON;
  }
  const order = fighters(world).map(p => p.id);
  // Alternate who opens the round.
  world.turns = createTurns(order, world.time, RULES.turnSeconds, world.match.round % 2 === 1 ? 0 : 1);
  rollWind(world, ctx);
  ctx.log(`⚔ Round ${world.match.round}: ${order.map(id => world.players[id].name).join(' vs ')}`);
  ctx.emit('sound', { kind: 'start' });
}

function rollWind(world: World, ctx: GameContext<World>) {
  world.wind = Math.round(range(ctx.random, -RULES.maxWind, RULES.maxWind) * 2) / 2;
}

function passTurn(world: World, ctx: GameContext<World>) {
  if (!world.turns) return;
  world.shotFired = false;
  world.retreatUntil = 0;
  nextTurn(world.turns, world.time, RULES.turnSeconds, id => (world.players[id]?.hp ?? 0) > 0);
  rollWind(world, ctx);
}

export function step(world: World, registry: DuelRegistry, inputs: Readonly<Record<string, Input>>, dt: number, ctx: GameContext<World>) {
  world.effects = pruneEffects(world.effects, world.time, 2);
  const seated = fighters(world).filter(p => p.online).map(p => p.id);
  const event = stepMatch(world.match, world.time, seated, { minPlayers: 2, countdown: 3 });
  if (event === 'start') startRound(world, registry, ctx);
  if (event === 'countdown') ctx.emit('sound', { kind: 'tick' });

  // Walking and falling (everyone, every phase).
  const turns = world.turns;
  for (const player of fighters(world)) {
    const input = inputs[player.id];
    const active = world.match.phase === 'playing' && !!turns && turns.order[turns.index] === player.id && player.hp > 0;
    const canWalk = active && (!world.shotFired || world.retreatUntil > world.time);
    if (input && active && !world.shotFired) player.aim = clamp(input.aim, 0, 180);
    if (input && canWalk && input.move) {
      player.x = clamp(player.x + clamp(input.move, -1, 1) * RULES.moveSpeed * dt, -RULES.width / 2 + 1, RULES.width / 2 - 1);
      player.facing = input.move > 0 ? 1 : -1;
      // Walking up a slope: step onto it unless it is a wall.
      const ground = heightAt(world.terrain, player.x);
      if (ground > player.z && ground - player.z < 1.2) player.z = ground;
    }
    const ground = heightAt(world.terrain, player.x);
    if (player.z > ground + 1e-3) { player.vz -= RULES.gravity * dt; player.z = Math.max(ground, player.z + player.vz * dt); }
    else { player.z = ground; player.vz = 0; }
    if (player.z < -4 && player.hp > 0) { player.hp = 0; ctx.log(`${player.name} fell into the abyss.`); }
  }
  if (world.match.phase !== 'playing' || !turns) return;

  const sim = makeSim(world, registry, ctx);
  stepProjectiles(world.projectiles, {
    dt, time: world.time,
    accelerate: p => {
      const def = registry.kinds.weapons[p.kind];
      return { x: world.wind * (def?.wind ?? 1), z: -RULES.gravity * (def?.gravity ?? 1) };
    },
    hit: p => fighters(world).find(player => player.hp > 0 && (player.id !== p.owner || world.time - Number(p.data.launchedAt ?? 0) > 0.3) && Math.hypot(player.x - p.x, player.z + 0.8 - p.z) < RULES.playerRadius + p.radius),
    solid: point => point.z <= heightAt(world.terrain, point.x) || Math.abs(point.x) > RULES.width / 2 + 10 || point.z < -10,
    onImpact: (p, _target, at) => {
      const def = registry.kinds.weapons[p.kind];
      if (!def || Math.abs(at.x) > RULES.width / 2 + 5) return;
      if (def.onImpact) def.onImpact(sim, p, at);
      else sim.explode(at, def.radius, def.damage, p.owner);
    },
  });

  const alive = fighters(world).filter(p => p.hp > 0);
  if (alive.length <= 1) {
    const winner = alive[0];
    if (winner) winner.wins++;
    endMatch(world.match, world.time, winner?.id ?? null, winner ? 'last standing' : 'draw');
    ctx.log(winner ? `🏆 ${winner.name} wins round ${world.match.round}!` : 'Draw!');
    ctx.emit('sound', { kind: 'win' });
    world.turns = null;
    return;
  }

  if (world.shotFired && !Object.keys(world.projectiles).length) {
    if (!world.retreatUntil) { world.retreatUntil = world.time + RULES.retreatSeconds; resumeTurn(turns, world.time, RULES.retreatSeconds); }
    else if (world.time >= world.retreatUntil) passTurn(world, ctx);
  } else if (turnExpired(turns, world.time)) passTurn(world, ctx);
}

export function command(world: World, registry: DuelRegistry, playerId: string, command: Command, ctx: GameContext<World>): string | void {
  const player = world.players[playerId];
  if (!player) return;
  switch (command.type) {
    case 'ready': {
      if (player.seat < 0) return 'You are watching — both seats are taken.';
      if (world.match.phase === 'ended') toLobby(world.match);
      setReady(world.match, playerId, !world.match.ready[playerId]);
      return;
    }
    case 'weapon': {
      const def = registry.kinds.weapons[command.id];
      if (!def || def.hidden) return 'Unknown weapon.';
      player.weapon = def.id;
      return;
    }
    case 'fire': {
      const turns = world.turns;
      if (world.match.phase !== 'playing' || !turns || turns.order[turns.index] !== playerId) return 'Not your turn.';
      if (world.shotFired || !isTurnOf(turns, playerId)) return 'You already fired this turn.';
      const def = registry.kinds.weapons[player.weapon];
      if (!def) return 'Unknown weapon.';
      if (def.ammo !== undefined && (player.ammo[def.id] ?? 0) <= 0) return `${def.name}: no ammo left.`;
      const power = clamp(Number.isFinite(command.power) ? command.power : 0.5, 0.05, 1);
      const sim = makeSim(world, registry, ctx);
      const count = def.count ?? 1;
      for (let i = 0; i < count; i++) {
        const offset = count > 1 ? ((i / (count - 1)) - 0.5) * (def.spread ?? 10) : 0;
        sim.launch(def.id, muzzle(player, player.aim), player.aim + offset, def.speed * power, playerId);
      }
      for (const projectile of Object.values(world.projectiles)) projectile.data.launchedAt ??= world.time;
      if (def.ammo !== undefined) player.ammo[def.id] = (player.ammo[def.id] ?? def.ammo) - 1;
      world.shotFired = true;
      freezeTurn(turns, world.time);
      ctx.emit('sound', { kind: 'fire' });
      return;
    }
    default:
      return `Unknown command ${(command as { type: string }).type}.`;
  }
}

/**
 * A second human replaces a bot: seats go to people first.
 * (Engine bots never take a seat away from a connecting player.)
 */
export function onPlayerOnline(world: World, player: Player, online: boolean, ctx: GameContext<World>) {
  if (!online || player.seat >= 0 || ctx.isBot(player.id)) return;
  const bot = fighters(world).find(p => ctx.isBot(p.id));
  if (!bot) return;
  const seat = bot.seat;
  ctx.removePlayer(bot.id);
  player.seat = seat;
  if (world.match.phase === 'playing' || world.match.phase === 'countdown') { endMatch(world.match, world.time, null, 'player joined'); toLobby(world.match); world.turns = null; world.projectiles = {}; }
  ctx.log(`${player.name} takes the seat of ${bot.name}.`);
}

/** Computer opponent: readies up, then aims a ballistic shot at the enemy with some error. */
export function botInput(world: World, id: string, ctx: GameContext<World>, registry: DuelRegistry): Input | undefined {
  const bot = world.players[id];
  if (!bot || bot.seat < 0) return undefined;
  if ((world.match.phase === 'lobby' || world.match.phase === 'ended') && !world.match.ready[id]) { ctx.command(id, { type: 'ready' }); return undefined; }
  const turns = world.turns;
  if (world.match.phase !== 'playing' || !turns || turns.order[turns.index] !== id || world.shotFired) return { move: 0, aim: bot.aim };
  const enemy = fighters(world).find(p => p.id !== id && p.hp > 0);
  if (!enemy) return { move: 0, aim: bot.aim };
  const def = registry.kinds.weapons[bot.weapon] ?? registry.kinds.weapons[DEFAULT_WEAPON];
  const power = 0.85;
  // Aim once per turn (stored in data so it survives reloads), with a human-ish error.
  const turnKey = `duel-bot-turn`;
  if (bot.data[turnKey] !== turns.turn) {
    const from = muzzle(bot, bot.aim);
    const radians = ballisticAngle(from, { x: enemy.x, z: enemy.z + 0.8 }, def.speed * power, RULES.gravity * (def.gravity ?? 1));
    const degrees = radians === null ? (enemy.x > bot.x ? 50 : 130) : (radians * 180) / Math.PI;
    bot.data['duel-bot-aim'] = clamp(degrees + range(ctx.random, -3, 3) - world.wind * 0.4 * Math.sign(enemy.x - bot.x), 5, 175);
    bot.data[turnKey] = turns.turn;
  }
  const target = Number(bot.data['duel-bot-aim']);
  const elapsed = RULES.turnSeconds - turnTimeLeft(turns, world.time);
  if (elapsed > 1.5 && Math.abs(bot.aim - target) < 1) ctx.command(id, { type: 'fire', power });
  return { move: 0, aim: bot.aim + clamp(target - bot.aim, -RULES.aimSpeed / 30, RULES.aimSpeed / 30) };
}
