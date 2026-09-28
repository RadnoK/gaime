import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@colyseus/sdk';
import { baseWorld, type BasePlayer, type BaseWorld } from '../src/shared';
import { adminToken, createGameServer, defineGame } from '../src/server';
import { smoke } from '../../host/src/smoke.mjs';

type World = BaseWorld<BasePlayer & { x: number }> & { ticks: number; crash: boolean; secrets: Record<string, string> };

const game = defineGame<World, { dx: number }>({
  name: 'test-game',
  createWorld: () => ({ ...baseWorld(1), ticks: 0, crash: false, secrets: {} }),
  createPlayer: (world, id, name) => { world.secrets[id] = `secret of ${name}`; return { id, name, online: true, data: {}, x: 0 }; },
  bot: () => ({ dx: 1 }),
  admin: { double: { description: 'double the ticks', run: world => { world.ticks *= 2; return { ticks: world.ticks }; } } },
  // Everyone sees only their own secret.
  view: (world, playerId) => ({ ...world, secrets: world.secrets[playerId] ? { [playerId]: world.secrets[playerId] } : {} }),
  parseInput: raw => (Number.isFinite((raw as { dx?: number })?.dx) ? { dx: (raw as { dx: number }).dx } : undefined),
  step(world, inputs, dt) {
    if (world.crash) throw new Error('boom');
    world.ticks++;
    for (const [id, input] of Object.entries(inputs)) world.players[id].x += input.dx * dt;
  },
  command(world, id, command, ctx) {
    if (command.type === 'crash') world.crash = true;
    if (command.type === 'ping') return 'pong';
    if (command.type === 'boom') ctx.emit('sound', { kind: 'boom' });
    if (command.type === 'burst') { for (let i = 0; i < 3; i++) ctx.emit('pop', i); ctx.after(0.1, 'later.done', { ok: true }); }
    if (command.type === 'later') ctx.job(Promise.resolve(41), (w, value) => { w.ticks = -1000; ctx.notify(id, `job ${value + 1}`); });
    if (command.type === 'explode') throw new Error('kaboom');
    if (command.type === 'relay') return `relayed: ${ctx.command(id, { type: 'explode' })}`;
  },
  requests: {
    double: (_world, _id, payload) => (payload as number) * 2,
    broken: () => { throw new Error('not this time'); },
  },
  chat: { commands: { roll: { description: 'roll a die', run: () => 'rolled a 6' } } },
  network: { events: ['later.done'] },
  systems: [{ id: 'count', every: 0.5, run: () => {} }],
});

let data: string;
let server: ReturnType<typeof createGameServer<World, { dx: number }>>;
let url: string;

async function boot() {
  server = createGameServer(game);
  await server.listen(0);
  const address = (server.transport as unknown as { server: { address(): { port: number } } }).server.address();
  url = `http://localhost:${address.port}`;
}

beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), 'gaime-core-'));
  process.env.GAIME_DATA_DIR = data;
});
afterEach(async () => {
  await server?.gracefullyShutdown(false).catch(() => {});
  rmSync(data, { recursive: true, force: true });
});

describe('game server', () => {
  test('passes the end-to-end smoke test with real WebSocket clients', async () => {
    await boot();
    await smoke({ url, cwd: process.cwd() });
    const checkpoint = JSON.parse(readFileSync(join(data, 'checkpoint.json'), 'utf8'));
    expect(checkpoint.game).toBe('test-game');
    // Smoke bots join as `ephemeral`: nothing of them stays in the saved world.
    await until(() => Object.keys(JSON.parse(readFileSync(join(data, 'checkpoint.json'), 'utf8')).world.players).length === 0);
  }, 30000);

  test('a simulation error pauses the game and shows up in /health instead of crashing', async () => {
    await boot();
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const room = await new Client(url).joinById(roomId, { name: 'T', ticket: 'x'.repeat(24) });
    const notices: string[] = [];
    let world: World | undefined;
    room.onMessage('welcome', message => { world = message.world; });
    room.onMessage('patch', () => {});
    room.onMessage('notice', text => notices.push(text));
    await until(() => !!world);
    room.send('command', { type: 'ping' });
    await until(() => notices.includes('pong'));
    room.send('command', { type: 'crash' });
    await until(async () => (await (await fetch(`${url}/health`)).json()).error === 'boom');
    await room.leave();
  }, 20000);

  test('chat commands, RPC, events and async jobs', async () => {
    await boot();
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const room = await new Client(url).joinById(roomId, { name: 'Ala', ticket: 'y'.repeat(24) });
    const notices: string[] = [];
    const responses: Array<{ id: number; ok: boolean; result?: unknown; error?: string }> = [];
    const events: Array<{ name: string; data: unknown }> = [];
    let feed: Array<{ text: string; kind?: string }> = [];
    room.onMessage('welcome', message => { feed = message.world.feed; });
    room.onMessage('patch', patch => { feed = [...feed, ...(patch.streams?.feed?.add ?? [])]; });
    room.onMessage('notice', text => notices.push(text));
    room.onMessage('response', response => responses.push(response));
    room.onMessage('event', event => events.push(event));
    await until(() => feed.length > 0 || true);
    const say = async (text: string) => { room.send('command', { type: '$chat', text }); await new Promise(r => setTimeout(r, 400)); };
    await say('/help');
    await say('/roll');
    await say('/me dances');
    await say('/no-such-command');
    await until(() => notices.length >= 3);
    expect(notices[0]).toMatch(/\/roll — roll a die/);
    expect(notices).toContain('rolled a 6');
    expect(notices.some(n => /Unknown command/.test(n))).toBe(true);
    await until(() => feed.some(item => item.kind === 'me' && item.text === 'dances'));
    room.send('request', { id: 1, name: 'double', payload: 21 });
    room.send('request', { id: 2, name: 'broken' });
    await until(() => responses.length === 2);
    expect(responses.find(r => r.id === 1)).toMatchObject({ ok: true, result: 42 });
    expect(responses.find(r => r.id === 2)).toMatchObject({ ok: false, error: 'not this time' });
    room.send('command', { type: 'boom' });
    room.send('command', { type: 'later' });
    await until(() => events.length === 1 && notices.includes('job 42'));
    expect(events[0]).toEqual({ name: 'sound', data: { kind: 'boom' } });
    await room.leave();
  }, 20000);

  test('per-player views hide other players\' secrets in snapshots and patches', async () => {
    await boot();
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const join = async (name: string, ticket: string) => {
      const room = await new Client(url).joinById(roomId, { name, ticket });
      const state: { id: string; secrets: Record<string, string> } = { id: '', secrets: {} };
      room.onMessage('welcome', message => { state.id = message.id; state.secrets = message.world.secrets; });
      room.onMessage('patch', patch => { if (patch.values?.secrets) state.secrets = patch.values.secrets; });
      room.onMessage('notice', () => {});
      await until(() => !!state.id);
      return { room, state };
    };
    const a = await join('Ann', 'a'.repeat(24));
    const b = await join('Ben', 'b'.repeat(24));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(a.state.secrets).toEqual({ [a.state.id]: 'secret of Ann' });
    expect(b.state.secrets).toEqual({ [b.state.id]: 'secret of Ben' });
    await a.room.leave(); await b.room.leave();
  }, 20000);

  test('bots from /bot move by their brain; the admin API needs the token', async () => {
    await boot();
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const room = await new Client(url).joinById(roomId, { name: 'Host', ticket: 'h'.repeat(24) });
    room.onMessage('welcome', () => {}); room.onMessage('patch', () => {}); room.onMessage('notice', () => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    room.send('command', { type: '$chat', text: '/bot Robo' });
    const admin = async (action: string, body?: object, token = adminToken()) => {
      const response = await fetch(`${url}/gaime/admin/${action}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    await until(async () => (await admin('players')).body.some((p: { name: string }) => p.name === 'Robo'));
    await new Promise(resolve => setTimeout(resolve, 300));
    const world = (await admin('world')).body as World;
    const bot = Object.values(world.players).find(p => p.name === 'Robo')!;
    expect(bot.data['gaime-bot']).toBe(true);
    expect(bot.x).toBeGreaterThan(0);
    expect((await admin('players', undefined, 'wrong')).status).toBe(401);
    expect((await admin('command', { name: 'double', args: [] })).body).toHaveProperty('ticks');
    expect((await admin('command', { name: 'nope', args: [] })).status).toBe(400);
    await room.leave();
  }, 20000);

  test('ctx.command turns an error in game code into its reply instead of throwing', async () => {
    await boot();
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const room = await new Client(url).joinById(roomId, { name: 'Cmd', ticket: 'c'.repeat(24) });
    const notices: string[] = [];
    room.onMessage('welcome', () => {}); room.onMessage('patch', () => {});
    room.onMessage('notice', text => notices.push(text));
    room.send('command', { type: 'relay' });
    await until(() => notices.length > 0);
    expect(notices[0]).toBe('relayed: Error in the code of command "explode": kaboom');
    expect((await (await fetch(`${url}/health`)).json()).ok).toBe(true);
    await room.leave();
  }, 20000);

  test('a join with a taken name gets a free one; a rejoin never steals a name', async () => {
    await boot();
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const join = async (name: string, ticket: string) => {
      const room = await new Client(url).joinById(roomId, { name, ticket });
      const notices: string[] = [];
      room.onMessage('welcome', () => {}); room.onMessage('patch', () => {}); room.onMessage('notice', text => notices.push(text));
      return { room, notices };
    };
    const names = async () => (await (await fetch(`${url}/gaime/admin/players`, { headers: { authorization: `Bearer ${adminToken()}` } })).json()).map((p: { name: string }) => p.name).sort();
    const ann = await join('Ann', 'a'.repeat(24));
    const second = await join('ann', 'b'.repeat(24));
    await until(async () => (await names()).length === 2);
    expect(await names()).toEqual(['Ann', 'ann 2']);
    await second.room.leave();
    const bob = await join('Bob', 'b'.repeat(24));
    await until(async () => (await names()).includes('Bob'));
    await bob.room.leave();
    const thief = await join('ANN', 'b'.repeat(24));
    await until(() => thief.notices.some(text => /taken/.test(text)));
    expect(await names()).toEqual(['Ann', 'Bob']);
    await thief.room.leave(); await ann.room.leave();
  }, 20000);

  test('protocol 3 clients get one batched message per tick; timers fire forwarded events; stats show the parts', async () => {
    await boot();
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const room = await new Client(url).joinById(roomId, { name: 'B', ticket: 'b'.repeat(24), protocol: 3 });
    const batches: Array<Array<[string, unknown]>> = [];
    let welcomed = false;
    room.onMessage('welcome', () => { welcomed = true; });
    room.onMessage('patch', () => {});
    room.onMessage('events', list => batches.push(list));
    room.onMessage('event', () => { throw new Error('a protocol 3 client must not get single events'); });
    await until(() => welcomed);
    room.send('command', { type: 'burst' });
    await until(() => batches.flat().some(([name]) => name === 'later.done'));
    expect(batches[0]).toEqual([['pop', 0], ['pop', 1], ['pop', 2]]);
    expect(batches.flat()).toContainEqual(['later.done', { ok: true }]);
    await new Promise(resolve => setTimeout(resolve, 600));
    const stats = await (await fetch(`${url}/gaime/stats`)).json() as { parts: Array<{ name: string }>; engine: { events: number; timers: number } };
    expect(stats.parts.map(part => part.name)).toEqual(expect.arrayContaining(['game/step', 'game/count']));
    expect(stats.engine.timers).toBeGreaterThanOrEqual(1);
    await room.leave();
  }, 20000);

  test('/gaime/stats can be read repeatedly without resetting the event-loop measurements', async () => {
    await boot();
    const started = Date.now();
    while (Date.now() - started < 80) { /* block the event loop */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    const read = async () => (await (await fetch(`${url}/gaime/stats`)).json()) as { tickRate: number; eventLoopDelayMs: { max: number } };
    const first = await read();
    const second = await read();
    expect(first.eventLoopDelayMs.max).toBeGreaterThan(40);
    expect(second.eventLoopDelayMs.max).toBeGreaterThan(40);
    expect(first.tickRate).toBe(30);
  }, 20000);

  test('an unreadable checkpoint is never overwritten', async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'checkpoint.json'), '{ not json');
    await boot();
    await fetch(`${url}/gaime/room`);
    const health = await (await fetch(`${url}/health`)).json();
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/Corrupt checkpoint/);
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(readFileSync(join(data, 'checkpoint.json'), 'utf8')).toBe('{ not json');
  }, 20000);
});

async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error('timeout');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
