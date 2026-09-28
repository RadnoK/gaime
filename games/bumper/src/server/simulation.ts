import { baseWorld, clamp } from '@gaime/core';
import { cooldown, createMatch, endMatch, freeColor, pointInRing, setReady, status, stepMatch, toLobby, weighted } from '@gaime/core/kit';
import type { GameContext } from '@gaime/core/server';
import type { Command, Events, Input, Modifiers, Player, Sim, World } from '../shared/types';
import { DATA, dashLeft, RULES } from '../shared/rules';
import { physics } from './physics';
import type { BumperRegistry } from './registry';

export const SCHEMA = 1;
type Ctx = GameContext<World, Events, Modifiers>;

export function createWorld(): World {
  return { ...baseWorld(SCHEMA), match: createMatch(), arena: RULES.arena, pickups: {}, catalog: [] };
}

const inRound = (world: World) => world.match.phase === 'playing' || world.match.phase === 'countdown';

export function createPlayer(world: World, id: string, name: string, random = Math.random): Player {
  const at = pointInRing(random, { x: 0, z: 0 }, 0, world.arena * 0.6);
  return {
    id, name, online: true, data: {},
    x: at.x, z: at.z, vx: 0, vz: 0, angle: 0, spin: 0,
    color: freeColor(Object.values(world.players).map(p => p.color)),
    wins: 0,
    // Joining mid-round: watch until the next one.
    alive: !inRound(world), outAt: world.time, mass: 1,
  };
}

/** After load and every hot reload: refresh the catalog, drop pickups of removed modules. */
export function prepareWorld(world: World, registry: BumperRegistry) {
  world.catalog = registry.catalog;
  for (const pickup of Object.values(world.pickups)) if (!registry.kinds.powerups[pickup.kind]) delete world.pickups[pickup.id];
}

/** The facade module code works with: built once per tick by the engine (`GameDefinition.sim`). */
export function makeSim(registry: BumperRegistry, ctx: Ctx, dt: number): Sim {
  const world = ctx.world;
  const sim: Sim = {
    world, dt,
    random: ctx.random,
    trigger: (event: string, data?: unknown) => ctx.trigger(event as `${string}:${string}`, data),
    after: (seconds: number, event: string, data?: unknown, options?: { key?: string }) => { ctx.after(seconds, event as `${string}:${string}`, data, options); },
    cancel: key => { ctx.cancel(key); },
    modify: (name, value, data) => ctx.modify(name, value, data),
    log: ctx.log,
    emit: ctx.emit,
    isolate: (module, run) => ctx.isolate(module, run),
    resource: (key, create, options) => ctx.resource(key, create, options),
    lockRoom: locked => ctx.lockRoom(locked),
    fighters: () => Object.values(world.players).filter(p => p.alive),
    push: (playerId, impulse) => { physics.impulse(ctx, 'players', playerId, impulse); },
    knockOut(playerId, by = null) {
      const player = world.players[playerId];
      if (!player?.alive) return;
      player.alive = false;
      player.outAt = world.time;
      ctx.trigger('player.knocked', { player: playerId, by: by && by !== playerId && world.players[by] ? by : null });
    },
    spawnPickup(kind, at) {
      const def = kind ? registry.kinds.powerups[kind] : weighted(ctx.random, registry.lists.powerups, d => d.weight);
      if (!def) return undefined;
      const spot = at ?? pointInRing(ctx.random, { x: 0, z: 0 }, 0, world.arena * 0.7);
      const pickup = { id: `u${ctx.nextId()}`, kind: def.id, x: spot.x, z: spot.z };
      world.pickups[pickup.id] = pickup;
      ctx.trigger('pickup.spawned', { pickup: pickup.id, kind: def.id });
      return pickup;
    },
  };
  return sim;
}

/** Puts every present player on the start ring (sorted ids: deterministic), the rest out. */
function lineUp(sim: Sim, present: string[]) {
  const { world } = sim;
  const ids = [...present].sort();
  world.arena = RULES.arena;
  world.pickups = {};
  for (const player of Object.values(world.players)) {
    const index = ids.indexOf(player.id);
    sim.cancel(`player:${player.id}:respawn`);
    if (index < 0) { if (player.alive) Object.assign(player, { alive: false, outAt: world.time }); continue; }
    const a = (index / ids.length) * Math.PI * 2;
    Object.assign(player, { alive: true, x: Math.cos(a) * world.arena * 0.6, z: Math.sin(a) * world.arena * 0.6, vx: 0, vz: 0, angle: 0, spin: 0 });
    delete player.data[DATA.dash];
    delete player.data[DATA.hitBy];
  }
}

// ── Input (the game's `step`) ──

/** Steering: acceleration from the stick, through the `move.accel` modifiers. Frozen during the countdown. */
export function step(world: World, inputs: Readonly<Record<string, Input>>, dt: number, sim: Sim) {
  if (world.match.phase === 'countdown') return;
  for (const player of Object.values(world.players)) {
    const input = inputs[player.id];
    if (!player.alive || !input) continue;
    const length = Math.hypot(input.mx, input.mz);
    if (length < 0.05) continue;
    const accel = sim.modify('move.accel', RULES.accel, { player: player.id }) / Math.max(1, length);
    player.vx += input.mx * accel * dt;
    player.vz += input.mz * accel * dt;
  }
}

// ── Systems ──

/** input phase: lobby → countdown → playing → ended (kit match). */
export function runMatch(sim: Sim) {
  const { world } = sim;
  const present = Object.values(world.players).filter(p => p.online).map(p => p.id);
  const event = stepMatch(world.match, world.time, present, { minPlayers: 2, countdown: RULES.countdownSeconds, duration: RULES.roundSeconds });
  if (event === 'countdown') {
    lineUp(sim, present);
    sim.trigger('round.countdown', { seconds: RULES.countdownSeconds });
  }
  if (event === 'start') {
    lineUp(sim, present);
    sim.log(`⚔ Round ${world.match.round}: ${present.length} players. Last one on the arena wins.`);
    sim.trigger('round.started', { round: world.match.round, players: [...present].sort() });
  }
  if (event === 'timeout') {
    sim.log('⏱ Time is up — a draw.');
    sim.trigger('round.won', { round: world.match.round, player: null });
  }
}

/** Before the physics: each disc's density from the `push.mass` modifiers. */
export function updateMass(sim: Sim) {
  for (const player of sim.fighters()) player.mass = clamp(sim.modify('push.mass', 1, { player: player.id }), 0.1, 20);
}

/** After the physics: discs past the edge are out; the last one who touched them gets the credit. */
export function ringOut(sim: Sim) {
  const { world } = sim;
  for (const player of sim.fighters()) {
    if (Math.hypot(player.x, player.z) <= world.arena + RULES.edge) continue;
    const recent = world.time - Number(player.data[DATA.hitAt] ?? -Infinity) <= RULES.creditSeconds;
    sim.knockOut(player.id, recent ? String(player.data[DATA.hitBy]) : null);
  }
}

/** Discs rolling over a powerup collect it: a `powerup:<id>` status, then the definition's hook. */
export function collect(sim: Sim, registry: BumperRegistry) {
  const { world } = sim;
  for (const pickup of Object.values(world.pickups)) {
    const player = sim.fighters().find(p => Math.hypot(p.x - pickup.x, p.z - pickup.z) < RULES.radius + RULES.pickupRadius);
    if (!player) continue;
    delete world.pickups[pickup.id];
    const def = registry.kinds.powerups[pickup.kind];
    if (!def) continue;
    status.apply(player.data, `powerup:${def.id}`, world.time, def.duration);
    // A definition hook belongs to its module: an error switches that module off, not the game.
    if (def.onCollect) sim.isolate(registry.owner[`powerups/${def.id}`], () => def.onCollect!(sim, player, pickup));
    sim.trigger('pickup.collected', { player: player.id, pickup: pickup.id, kind: def.id });
  }
}

/** Late in a round the arena shrinks, so every round ends. */
export function shrink(sim: Sim) {
  const { world, dt } = sim;
  if (world.match.phase !== 'playing' || world.time - world.match.startedAt < RULES.shrinkAfter) return;
  world.arena = Math.max(RULES.minArena, world.arena - RULES.shrinkSpeed * dt);
}

/** Periodic: keep a few powerups on the arena during a round. */
export function spawn(sim: Sim) {
  if (sim.world.match.phase === 'playing' && Object.keys(sim.world.pickups).length < RULES.maxPickups) sim.spawnPickup();
}

/** late: one disc left (or none) ends the round. */
export function referee(sim: Sim) {
  const { world } = sim;
  if (world.match.phase !== 'playing') return;
  const alive = sim.fighters();
  if (alive.length > 1) return;
  const winner = alive[0] ?? null;
  endMatch(world.match, world.time, winner?.id ?? null, winner ? 'last standing' : 'draw');
  sim.log(winner ? `🏆 ${winner.name} wins round ${world.match.round}!` : 'Nobody is left — a draw.');
  sim.trigger('round.won', { round: world.match.round, player: winner?.id ?? null });
}

// ── Handlers ──

/** Discs touching: remember who hit whom (knockout credit), and report hard bumps. */
export function onContact({ a, b, started, speed }: Events['physics.contact'], sim: Sim) {
  const { world } = sim;
  if (!started || a.collection !== 'players' || b.collection !== 'players') return;
  const pa = world.players[a.id]; const pb = world.players[b.id];
  if (!pa || !pb) return;
  Object.assign(pa.data, { [DATA.hitBy]: pb.id, [DATA.hitAt]: world.time });
  Object.assign(pb.data, { [DATA.hitBy]: pa.id, [DATA.hitAt]: world.time });
  if (speed >= RULES.bumpSpeed) sim.trigger('player.bumped', { a: pa.id, b: pb.id, speed: Math.round(speed * 10) / 10 });
}

export function onKnocked({ player, by }: Events['player.knocked'], sim: Sim) {
  const { world } = sim;
  const out = world.players[player];
  if (!out) return;
  sim.log(by && world.players[by] ? `💥 ${world.players[by].name} pushed ${out.name} off the arena.` : `💨 ${out.name} fell off the arena.`);
  // Outside rounds, nobody stays out for long.
  if (!inRound(world)) sim.after(RULES.respawnSeconds, 'player.respawn', { player }, { key: `player:${player}:respawn` });
}

/** Scoring is a reaction to the event (modules can react too); then the arena is back to full size for everyone. */
export function onRoundWon({ player }: Events['round.won'], sim: Sim) {
  const { world } = sim;
  const winner = player ? world.players[player] : undefined;
  if (winner) winner.wins++;
  world.arena = RULES.arena;
  for (const p of Object.values(world.players)) if (!p.alive) sim.after(RULES.respawnSeconds, 'player.respawn', { player: p.id }, { key: `player:${p.id}:respawn` });
}

export function onRespawn({ player }: Events['player.respawn'], sim: Sim) {
  const { world } = sim;
  const p = world.players[player];
  if (!p || p.alive || inRound(world)) return;
  const at = pointInRing(sim.random, { x: 0, z: 0 }, 0, world.arena * 0.5);
  Object.assign(p, { alive: true, x: at.x, z: at.z, vx: 0, vz: 0, spin: 0 });
}

// ── Commands and bots ──

export function command(world: World, playerId: string, command: Command, ctx: Ctx): string | void {
  const player = world.players[playerId];
  if (!player) return;
  switch (command.type) {
    case 'ready': {
      if (world.match.phase === 'playing') return 'A round is on — you play in the next one.';
      if (world.match.phase === 'ended') toLobby(world.match);
      setReady(world.match, playerId, !world.match.ready[playerId]);
      return;
    }
    case 'dash': {
      if (!player.alive || world.match.phase === 'countdown') return;
      let x = Number(command.x); let z = Number(command.z);
      if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) < 1e-3) { x = player.vx; z = player.vz; }
      const length = Math.hypot(x, z);
      // No direction, or still cooling down: ignore quietly (players mash the key).
      if (length < 0.1 || !cooldown.use(player.data, DATA.dash, world.time, RULES.dashCooldown)) return;
      const power = ctx.modify('dash.power', RULES.dash, { player: playerId });
      player.vx += (x / length) * power;
      player.vz += (z / length) * power;
      ctx.trigger('dash.used', { player: playerId, power });
      return;
    }
    default:
      return `Unknown command ${(command as { type: string }).type}.`;
  }
}

/** `/bot`: readies up, chases the nearest disc, dashes into it when lined up — and stays away from the edge. */
export function botInput(world: World, id: string, ctx: Ctx): Input | undefined {
  const bot = world.players[id];
  if (!bot) return undefined;
  const { phase } = world.match;
  const resting = phase === 'ended' && world.time - world.match.endedAt < 3;
  if ((phase === 'lobby' || phase === 'ended') && !resting && !world.match.ready[id]) ctx.command(id, { type: 'ready' });
  if (!bot.alive || phase === 'countdown') return { mx: 0, mz: 0 };
  const target = ctx.nearest<Player>('players', bot, undefined, p => p.id !== id && p.alive);
  const r = Math.hypot(bot.x, bot.z) || 1e-6;
  let mx = 0; let mz = 0;
  if (target) {
    const dx = target.x - bot.x; const dz = target.z - bot.z;
    const d = Math.hypot(dx, dz) || 1;
    mx = dx / d; mz = dz / d;
    // Lined up (moving towards it), close, and the push sends it outwards rather than us.
    const speed = Math.hypot(bot.vx, bot.vz) || 1;
    const aligned = (bot.vx * dx + bot.vz * dz) / (speed * d) > 0.85;
    const outwards = target.x * dx + target.z * dz > 0;
    if (d < 4 && aligned && outwards && dashLeft(bot, world.time) === 0 && ctx.random() < 0.25) ctx.command(id, { type: 'dash', x: dx, z: dz });
  }
  // Near the edge (or flying towards it) the centre wins over the target.
  const outSpeed = (bot.vx * bot.x + bot.vz * bot.z) / r;
  const danger = clamp((r - world.arena * 0.55) / (world.arena * 0.35) + Math.max(0, outSpeed) * 0.08, 0, 1);
  mx = mx * (1 - danger) - (bot.x / r) * danger * 1.5;
  mz = mz * (1 - danger) - (bot.z / r) * danger * 1.5;
  return { mx: clamp(mx, -1, 1), mz: clamp(mz, -1, 1) };
}
