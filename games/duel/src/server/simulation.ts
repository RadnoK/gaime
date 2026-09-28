import { baseWorld, clamp } from '@gaime/core';
import {
  addEffect, ballisticAngle, createMatch, createTurns, currentTurn, endMatch, freezeTurn, isTurnOf, launch, nextTurn,
  pruneEffects, range, setReady, stepMatch, stepProjectiles, toLobby, turnTimeLeft,
} from '@gaime/core/kit';
import type { GameContext } from '@gaime/core/server';
import type { Command, Events, Impact, Input, Player, Sim, World } from '../shared/types';
import { carve, generateTerrain, heightAt, muzzle, RULES } from '../shared/rules';
import { DEFAULT_WEAPON, type DuelRegistry } from './registry';

/** 2: `shotFired` + `retreatUntil` became `turnPhase`; turn ends are timers (`turn:end`). */
export const SCHEMA = 2;
type Ctx = GameContext<World, Events>;

/** Timer key of the pending end of the current turn (timeout, or the end of the retreat). */
const TURN_END = 'turn:end';

export function createWorld(): World {
  return {
    ...baseWorld(SCHEMA),
    match: createMatch(), turns: null, turnPhase: 'aim', terrain: generateTerrain(1), wind: 0,
    projectiles: {}, effects: [], catalog: [],
  };
}

export function migrate(world: World): World {
  if (world.schema < 2) {
    const old = world as World & { shotFired?: boolean; retreatUntil?: number };
    world.turnPhase = !old.shotFired ? 'aim' : old.retreatUntil ? 'retreat' : 'flight';
    // The retreat used to end at `retreatUntil`; now the turn clock shows it (and `prepare` schedules the timer).
    if (world.turnPhase === 'retreat' && world.turns) Object.assign(world.turns, { frozen: null, endsAt: Math.max(world.time, old.retreatUntil ?? 0) });
    delete old.shotFired;
    delete old.retreatUntil;
    world.schema = 2;
  }
  return world;
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

/** After load and every hot reload: refresh the catalog, drop what removed modules left behind, keep the turn ending. */
export function prepareWorld(world: World, registry: DuelRegistry, ctx: Ctx) {
  world.catalog = registry.catalog;
  for (const player of Object.values(world.players)) if (!registry.kinds.weapons[player.weapon]) player.weapon = DEFAULT_WEAPON;
  for (const projectile of Object.values(world.projectiles)) if (!registry.kinds.weapons[projectile.kind]) delete world.projectiles[projectile.id];
  // Outside `flight` a turn always has a pending end — also in saves from before turn timers.
  const turns = world.turns;
  if (world.match.phase === 'playing' && turns && world.turnPhase !== 'flight' && ctx.timeLeft(TURN_END) === undefined) {
    if (turns.frozen !== null) Object.assign(turns, { endsAt: world.time + turns.frozen, frozen: null });
    ctx.after(Math.max(0, turns.endsAt - world.time), 'turn.expired', { turn: turns.turn }, { key: TURN_END });
  }
}

/** The facade module code works with: built once per tick by the engine (`GameDefinition.sim`). */
export function makeSim(registry: DuelRegistry, ctx: Ctx, dt: number): Sim {
  const world = ctx.world;
  const sim: Sim = {
    world, dt,
    random: ctx.random,
    trigger: (event: string, data?: unknown) => ctx.trigger(event as `${string}:${string}`, data),
    after: (seconds: number, event: string, data?: unknown, options?: { key?: string }) => { ctx.after(seconds, event as `${string}:${string}`, data, options); },
    cancel: (key, prefix) => { ctx.cancel(key, { prefix }); },
    modify: (name, value, data) => ctx.modify(name, value, data),
    log: ctx.log,
    emit: ctx.emit,
    isolate: (module, run) => ctx.isolate(module, run),
    fighters: () => fighters(world),
    heightAt: x => heightAt(world.terrain, x),
    explode(at, radius, damage, by, weapon = 'explosion') {
      if (!(radius > 0)) return;
      carve(world.terrain, at, radius);
      addEffect(world.effects, ctx.nextId(), 'explosion', world.time, at, { radius, color: '#ff8a3d' });
      for (const player of fighters(world)) {
        const distance = Math.hypot(player.x - at.x, player.z + 0.8 - at.z);
        const reach = radius + RULES.playerRadius;
        if (distance > reach || player.hp <= 0) continue;
        const falloff = damage * (1 - Math.min(1, distance / reach) * 0.7);
        const hit = Math.max(0, Math.round(ctx.modify('shell.damage', falloff, { player: player.id, by, weapon, distance })));
        if (!hit) continue;
        player.hp = Math.max(0, player.hp - hit);
        addEffect(world.effects, ctx.nextId(), 'text', world.time, player, { text: `-${hit}`, color: player.id === by ? '#ffd659' : '#ff5977', y: 3 });
        ctx.trigger('player.hit', { player: player.id, by, weapon, damage: hit });
        if (player.hp <= 0) ctx.trigger('player.died', { player: player.id, by, cause: 'shell' });
      }
      // Craters can take the ground away: let players fall.
      for (const player of fighters(world)) if (player.z > heightAt(world.terrain, player.x)) player.vz = Math.min(player.vz, 0);
      // Array identity changes, so the patch sends the terrain once per explosion.
      world.terrain = [...world.terrain];
      ctx.trigger('shell.exploded', { x: at.x, z: at.z, radius, by, weapon });
    },
    launch(weapon, from, angleDegrees, speed, owner) {
      const id = `s${ctx.nextId()}`;
      // Kit angles are measured from +Z (our "up"); weapon angles from +X.
      const shell = launch({ id, kind: weapon, owner, from, angle: ((90 - angleDegrees) * Math.PI) / 180, speed, radius: 0.25, life: 12, time: world.time, data: { launchedAt: world.time } });
      world.projectiles[id] = shell;
      return shell;
    },
  };
  return sim;
}

// ── Round and turn rules ──

function startRound(sim: Sim, registry: DuelRegistry) {
  const { world } = sim;
  world.terrain = generateTerrain(Math.floor(sim.random() * 1e9));
  world.projectiles = {};
  world.effects = [];
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
  world.turnPhase = 'aim';
  sim.log(`⚔ Round ${world.match.round}: ${order.map(id => world.players[id].name).join(' vs ')}`);
  sim.trigger('match.started', { round: world.match.round, players: order });
  beginTurn(sim);
}

/** The current player's turn starts: new wind, the turn timer, `turn.started`. */
function beginTurn(sim: Sim) {
  const { world } = sim;
  const turns = world.turns!;
  const player = currentTurn(turns) ?? '';
  const wind = sim.modify('wind.strength', range(sim.random, -RULES.maxWind, RULES.maxWind), { player, turn: turns.turn });
  world.wind = Math.round(wind * 2) / 2;
  sim.after(RULES.turnSeconds, 'turn.expired', { turn: turns.turn }, { key: TURN_END });
  sim.trigger('turn.started', { player, turn: turns.turn, wind: world.wind });
}

function passTurn(sim: Sim) {
  const { world } = sim;
  if (!world.turns) return;
  world.turnPhase = 'aim';
  nextTurn(world.turns, world.time, RULES.turnSeconds, id => (world.players[id]?.hp ?? 0) > 0);
  beginTurn(sim);
}

/** Ends the round (no-op unless playing): wins, lifecycle, pending turn timers, `match.ended`. */
function endRound(sim: Sim, winner: Player | null, reason: string) {
  const { world } = sim;
  if (world.match.phase !== 'playing') return;
  if (winner) winner.wins++;
  endMatch(world.match, world.time, winner?.id ?? null, reason);
  world.turns = null;
  world.turnPhase = 'aim';
  sim.cancel('turn:', true);
  sim.trigger('match.ended', { round: world.match.round, winner: winner?.id ?? null, reason });
}

// ── Input (the game's `step`) ──

/** Only the active player walks and aims: aiming until they fire, walking also during the retreat. */
export function step(world: World, inputs: Readonly<Record<string, Input>>, dt: number) {
  const turns = world.turns;
  if (world.match.phase !== 'playing' || !turns) return;
  const player = world.players[currentTurn(turns) ?? ''];
  const input = player && inputs[player.id];
  if (!input || player.hp <= 0 || player.seat < 0) return;
  if (world.turnPhase === 'aim') player.aim = clamp(input.aim, 0, 180);
  if (world.turnPhase === 'flight' || !input.move) return;
  player.x = clamp(player.x + clamp(input.move, -1, 1) * RULES.moveSpeed * dt, -RULES.width / 2 + 1, RULES.width / 2 - 1);
  player.facing = input.move > 0 ? 1 : -1;
  // Walking up a slope: step onto it unless it is a wall.
  const ground = heightAt(world.terrain, player.x);
  if (ground > player.z && ground - player.z < 1.2) player.z = ground;
}

// ── Systems ──

/** input phase: lobby → countdown → playing (kit match); a start resets the field. */
export function runMatch(sim: Sim, registry: DuelRegistry) {
  const { world } = sim;
  const seated = fighters(world).filter(p => p.online).map(p => p.id);
  const event = stepMatch(world.match, world.time, seated, { minPlayers: 2, countdown: RULES.countdownSeconds });
  if (event === 'countdown') sim.trigger('match.countdown', { seconds: RULES.countdownSeconds });
  if (event === 'start') startRound(sim, registry);
}

/** Gravity for fighters in every phase; falling off the map is fatal. */
export function fall(sim: Sim) {
  const { world, dt } = sim;
  for (const player of fighters(world)) {
    const ground = heightAt(world.terrain, player.x);
    if (player.z > ground + 1e-3) { player.vz -= RULES.gravity * dt; player.z = Math.max(ground, player.z + player.vz * dt); }
    else { player.z = ground; player.vz = 0; }
    if (player.z < -4 && player.hp > 0) {
      player.hp = 0;
      sim.log(`${player.name} fell into the abyss.`);
      sim.trigger('player.died', { player: player.id, by: null, cause: 'fall' });
    }
  }
}

/** Ballistics with wind; every impact becomes a `shell.impact` event. */
export function moveShells(sim: Sim, registry: DuelRegistry) {
  const { world } = sim;
  if (world.match.phase !== 'playing') return;
  stepProjectiles(world.projectiles, {
    dt: sim.dt, time: world.time,
    accelerate: p => {
      const def = registry.kinds.weapons[p.kind];
      return { x: world.wind * (def?.wind ?? 1), z: -RULES.gravity * (def?.gravity ?? 1) };
    },
    hit: p => fighters(world).find(player => player.hp > 0 && (player.id !== p.owner || world.time - Number(p.data.launchedAt ?? 0) > 0.3) && Math.hypot(player.x - p.x, player.z + 0.8 - p.z) < RULES.playerRadius + p.radius),
    solid: point => point.z <= heightAt(world.terrain, point.x) || Math.abs(point.x) > RULES.width / 2 + 10 || point.z < -10,
    onImpact: (p, target, at) => {
      // Far off the map: the shell is simply lost.
      if (Math.abs(at.x) > RULES.width / 2 + 5) return;
      sim.trigger('shell.impact', { shell: p.id, weapon: p.kind, owner: p.owner, x: at.x, z: at.z, vx: p.vx, vz: p.vz, target: target?.id ?? null, data: { ...p.data } });
    },
  });
}

/** The round ends when at most one fighter is alive (a hit, a fall, or a player leaving). */
export function referee(sim: Sim) {
  const { world } = sim;
  if (world.match.phase !== 'playing') return;
  const alive = fighters(world).filter(p => p.hp > 0);
  if (alive.length > 1) return;
  const winner = alive[0] ?? null;
  sim.log(winner ? `🏆 ${winner.name} wins round ${world.match.round}!` : 'Draw!');
  endRound(sim, winner, winner ? 'last standing' : 'draw');
}

/** `flight` → `retreat` once every shell (bomblets included) has landed. */
export function resolveShots(sim: Sim) {
  const { world } = sim;
  const turns = world.turns;
  if (world.match.phase !== 'playing' || !turns || world.turnPhase !== 'flight' || Object.keys(world.projectiles).length) return;
  world.turnPhase = 'retreat';
  // The turn clock shows the retreat; the timer ends it.
  Object.assign(turns, { frozen: null, endsAt: world.time + RULES.retreatSeconds });
  sim.after(RULES.retreatSeconds, 'turn.expired', { turn: turns.turn }, { key: TURN_END });
  sim.trigger('turn.resolved', { player: currentTurn(turns) ?? '', turn: turns.turn });
}

export function fadeEffects(sim: Sim) {
  sim.world.effects = pruneEffects(sim.world.effects, sim.world.time, 2);
}

// ── Handlers ──

/** `shell.impact`: the weapon's own `onImpact` (isolated), or the default explosion through `shell.radius`. */
export function impact(event: Impact, sim: Sim, registry: DuelRegistry) {
  const def = registry.kinds.weapons[event.weapon];
  if (!def) return;
  // A failing or disabled hook falls back to the default explosion.
  if (def.onImpact && sim.isolate(registry.owner[`weapons/${def.id}`], () => { def.onImpact!(sim, event); return true; })) return;
  const radius = sim.modify('shell.radius', def.radius, { weapon: def.id, owner: event.owner });
  sim.explode(event, radius, def.damage, event.owner, def.id);
}

/** `turn.expired` (timer `turn:end`): pass the turn, unless it already moved on or shells are flying. */
export function expireTurn(turn: number, sim: Sim) {
  const { world } = sim;
  if (world.match.phase !== 'playing' || world.turns?.turn !== turn || world.turnPhase === 'flight') return;
  passTurn(sim);
}

// ── Commands and players ──

export function command(world: World, registry: DuelRegistry, playerId: string, command: Command, ctx: Ctx): string | void {
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
      if (world.match.phase !== 'playing' || !turns || currentTurn(turns) !== playerId) return 'Not your turn.';
      if (world.turnPhase !== 'aim' || !isTurnOf(turns, playerId)) return 'You already fired this turn.';
      if (player.hp <= 0) return 'You are out.';
      const def = registry.kinds.weapons[player.weapon];
      if (!def) return 'Unknown weapon.';
      if (def.ammo !== undefined && (player.ammo[def.id] ?? 0) <= 0) return `${def.name}: no ammo left.`;
      const power = clamp(Number.isFinite(command.power) ? command.power : 0.5, 0.05, 1);
      const sim = makeSim(registry, ctx, 0);
      const count = def.count ?? 1;
      for (let i = 0; i < count; i++) {
        const offset = count > 1 ? ((i / (count - 1)) - 0.5) * (def.spread ?? 10) : 0;
        sim.launch(def.id, muzzle(player, player.aim), player.aim + offset, def.speed * power, playerId);
      }
      if (def.ammo !== undefined) player.ammo[def.id] = (player.ammo[def.id] ?? def.ammo) - 1;
      // The clock stops while the shells fly; `resolveShots` starts the retreat.
      world.turnPhase = 'flight';
      freezeTurn(turns, world.time);
      ctx.cancel(TURN_END);
      ctx.trigger('shell.fired', { player: playerId, weapon: def.id, power });
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
export function onPlayerOnline(world: World, player: Player, online: boolean, ctx: Ctx, registry: DuelRegistry) {
  if (!online || player.seat >= 0 || ctx.isBot(player.id)) return;
  const bot = fighters(world).find(p => ctx.isBot(p.id));
  if (!bot) return;
  const seat = bot.seat;
  ctx.removePlayer(bot.id);
  player.seat = seat;
  if (world.match.phase === 'playing' || world.match.phase === 'countdown') {
    endRound(makeSim(registry, ctx, 0), null, 'player joined');
    toLobby(world.match);
    world.projectiles = {};
  }
  ctx.log(`${player.name} takes the seat of ${bot.name}.`);
}

/** Computer opponent: readies up, then aims a ballistic shot at the enemy with some error. */
export function botInput(world: World, id: string, ctx: Ctx, registry: DuelRegistry): Input | undefined {
  const bot = world.players[id];
  if (!bot || bot.seat < 0) return undefined;
  if ((world.match.phase === 'lobby' || world.match.phase === 'ended') && !world.match.ready[id]) { ctx.command(id, { type: 'ready' }); return undefined; }
  const turns = world.turns;
  if (world.match.phase !== 'playing' || !turns || currentTurn(turns) !== id || world.turnPhase !== 'aim') return { move: 0, aim: bot.aim };
  const enemy = fighters(world).find(p => p.id !== id && p.hp > 0);
  if (!enemy) return { move: 0, aim: bot.aim };
  const def = registry.kinds.weapons[bot.weapon] ?? registry.kinds.weapons[DEFAULT_WEAPON];
  const power = 0.85;
  // Aim once per turn (stored in data so it survives reloads), with a human-ish error.
  const turnKey = `${world.match.round}:${turns.turn}`;
  if (bot.data['duel-bot-turn'] !== turnKey) {
    const from = muzzle(bot, bot.aim);
    const radians = ballisticAngle(from, { x: enemy.x, z: enemy.z + 0.8 }, def.speed * power, RULES.gravity * (def.gravity ?? 1));
    const degrees = radians === null ? (enemy.x > bot.x ? 50 : 130) : (radians * 180) / Math.PI;
    bot.data['duel-bot-aim'] = clamp(degrees + range(ctx.random, -3, 3) - world.wind * 0.4 * Math.sign(enemy.x - bot.x), 5, 175);
    bot.data['duel-bot-turn'] = turnKey;
  }
  const target = Number(bot.data['duel-bot-aim']);
  const elapsed = RULES.turnSeconds - turnTimeLeft(turns, world.time);
  if (elapsed > 1.5 && Math.abs(bot.aim - target) < 1) ctx.command(id, { type: 'fire', power });
  return { move: 0, aim: bot.aim + clamp(target - bot.aim, -RULES.aimSpeed / 30, RULES.aimSpeed / 30) };
}
