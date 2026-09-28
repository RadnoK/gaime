import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as path } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, type Room } from '@colyseus/sdk';
import { baseWorld, type BasePlayer, type BaseWorld } from '../src/shared';
import { adminToken, createGameServer, defineGame } from '../src/server';
import { GameClient } from '../src/client/client';
import { smoke } from '../../host/src/smoke.mjs';

type World = BaseWorld<BasePlayer> & { ticks: number };

const definition = (name: string, rooms?: { mode: 'matches'; size: number; private?: boolean }) => defineGame<World, unknown>({
  name,
  rooms,
  reconnectSeconds: 2,
  createWorld: () => ({ ...baseWorld(1), ticks: 0 }),
  createPlayer: (_world, id, name) => ({ id, name, online: true, data: {} }),
  parseInput: () => undefined,
  step(world) { world.ticks++; },
  command(_world, _id, command, ctx) {
    if (command.type === 'lock') ctx.lockRoom(true);
    if (command.type === 'unlock') ctx.lockRoom(false);
  },
  requests: { where: (_world, _id, _payload, ctx) => ctx.room },
});

const matchGame = definition('match-game', { mode: 'matches', size: 2 });
const sharedGame = definition('shared-game');

let data: string;
let server: ReturnType<typeof createGameServer<World, unknown>> | undefined;
let url: string;
const open: Room[] = [];

async function boot(game = matchGame) {
  const created = createGameServer(game);
  server = created;
  await created.listen(0);
  const address = (created.transport as unknown as { server: { address(): { port: number } } }).server.address();
  url = `http://localhost:${address.port}`;
}

beforeEach(() => {
  data = mkdtempSync(path(tmpdir(), 'gaime-rooms-'));
  process.env.GAIME_DATA_DIR = data;
  process.env.GAIME_EMPTY_ROOM_SECONDS = '0.5';
});
afterEach(async () => {
  for (const room of open.splice(0)) { room.reconnection.enabled = false; try { if (room.connection.isOpen) await room.leave(true); } catch {} }
  await server?.gracefullyShutdown(false).catch(() => {});
  server = undefined;
  delete process.env.GAIME_EMPTY_ROOM_SECONDS;
  rmSync(data, { recursive: true, force: true });
});

const ticket = () => randomBytes(18).toString('base64url');
type Answer = { roomId: string; code?: string; mode: string; size?: number; reservation?: Parameters<Client['consumeSeatReservation']>[0]; error?: string };

async function post(body: Record<string, unknown>): Promise<{ status: number; body: Answer }> {
  const response = await fetch(`${url}/gaime/room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const get = async (query = '') => { const response = await fetch(`${url}/gaime/room${query}`); return { status: response.status, body: await response.json() as Answer }; };

/** Consume a reservation like GameClient does; resolves after the welcome. */
async function consume(answer: Answer, name = 'P') {
  const room = await new Client(url).consumeSeatReservation(answer.reservation!);
  open.push(room);
  const state: { id: string; room?: { id: string; code?: string }; notices: string[] } = { id: '', notices: [] };
  room.onMessage('welcome', message => { state.id = message.id; state.room = message.room; });
  for (const type of ['patch', 'event', 'events', 'response', 'removed']) room.onMessage(type, () => {});
  room.onMessage('notice', text => state.notices.push(text));
  await until(() => !!state.id);
  return { room, state, name };
}

async function join(body: Record<string, unknown> = {}) {
  const answer = await post({ ticket: ticket(), name: 'P', ...body });
  expect(answer.status).toBe(200);
  return { answer: answer.body, ...(await consume(answer.body)) };
}

async function admin(action: string, options: { room?: string; body?: object } = {}) {
  const query = options.room ? `?room=${encodeURIComponent(options.room)}` : '';
  const response = await fetch(`${url}/gaime/admin/${action}${query}`, {
    method: options.body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${adminToken()}`, 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

describe('matches mode', () => {
  test('players fill a room up to its size, then a new room opens', async () => {
    await boot();
    const peek = await get();
    expect(peek.body).toMatchObject({ mode: 'matches', size: 2 });
    const a = await join();
    const b = await join();
    const c = await join();
    expect(a.answer.roomId).toBe(peek.body.roomId);
    expect(b.answer.roomId).toBe(a.answer.roomId);
    expect(c.answer.roomId).not.toBe(a.answer.roomId);
    expect(a.state.room).toEqual({ id: a.answer.roomId });
    // A full room refuses a direct join by id.
    await expect(new Client(url).joinById(a.answer.roomId, { ticket: ticket() })).rejects.toThrow();
    const rooms = (await admin('rooms')).body as Array<{ id: string; clients: number; players: number; full: boolean; locked: boolean; private: boolean }>;
    expect(rooms).toHaveLength(2);
    await until(async () => ((await admin('rooms')).body as typeof rooms).find(room => room.id === a.answer.roomId)?.players === 2);
    expect(((await admin('rooms')).body as typeof rooms).find(room => room.id === a.answer.roomId)).toMatchObject({ clients: 2, full: true, locked: false, private: false });
    const health = await (await fetch(`${url}/health`)).json();
    expect(health).toMatchObject({ ok: true, rooms: 2 });
    const stats = await (await fetch(`${url}/gaime/stats`)).json();
    expect(stats).toMatchObject({ rooms: 2, clients: 3 });
  }, 30000);

  test('parallel joins never overfill a room', async () => {
    await boot();
    const answers = await Promise.all(Array.from({ length: 7 }, () => post({ ticket: ticket() })));
    expect(answers.every(answer => answer.status === 200)).toBe(true);
    const counts = new Map<string, number>();
    for (const { body } of answers) counts.set(body.roomId, (counts.get(body.roomId) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([1, 2, 2, 2]);
    await Promise.all(answers.map(({ body }) => consume(body)));
    // Racing tools that use GET + joinById: some joins fail, none gets past the seat limit.
    const racing = await Promise.allSettled(Array.from({ length: 5 }, async () => {
      const { body } = await get();
      const room = await new Client(url).joinById(body.roomId, { ticket: ticket() });
      open.push(room);
      room.onMessage('*', () => {});
    }));
    expect(racing.some(result => result.status === 'fulfilled')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    const rooms = (await admin('rooms')).body as Array<{ clients: number }>;
    expect(Math.max(...rooms.map(room => room.clients))).toBeLessThanOrEqual(2);
  }, 30000);

  test('ctx.lockRoom keeps new players out; the players of the room still get back in', async () => {
    await boot();
    const tickets = { a: ticket(), x: ticket() };
    const a = await join({ ticket: tickets.a });
    const x = await join({ ticket: tickets.x });
    const roomId = a.answer.roomId;
    expect(x.answer.roomId).toBe(roomId);
    a.room.send('command', { type: 'lock' });
    await until(async () => ((await admin('room', { room: roomId })).body as { locked: boolean }).locked);
    // A leaves on purpose: the seat frees up, but the room stays locked for strangers.
    await a.room.leave(true);
    await until(async () => ((await admin('rooms')).body as Array<{ id: string; clients: number }>).find(room => room.id === roomId)?.clients === 1);
    await expect(new Client(url).joinById(roomId, { ticket: ticket() })).rejects.toThrow(/locked/);
    const stranger = await post({ ticket: ticket(), room: roomId });
    expect(stranger.body.roomId).not.toBe(roomId);
    expect((await admin('rooms')).body.find((room: { id: string }) => room.id === roomId)).toMatchObject({ locked: true });
    // A comes back (a new page, no reconnection token): the room still knows the ticket.
    const back = await post({ ticket: tickets.a, room: roomId });
    expect(back.body.roomId).toBe(roomId);
    const again = await consume(back.body);
    expect(again.state.id).toBe(a.state.id);
    // Unlocked and with a free seat, the room takes new players again.
    await x.room.leave(true);
    again.room.send('command', { type: 'unlock' });
    await until(async () => !((await admin('room', { room: roomId })).body as { locked: boolean }).locked);
    await until(async () => ((await admin('rooms')).body as Array<{ id: string; clients: number }>).find(room => room.id === roomId)?.clients === 1);
    const other = (await admin('rooms')).body.find((room: { id: string }) => room.id === stranger.body.roomId);
    expect(other).toBeTruthy();
    const next = await post({ ticket: ticket() });
    expect([roomId, stranger.body.roomId]).toContain(next.body.roomId);
  }, 30000);

  test('private matches: invite codes, never matchmade, ctx.room knows the code', async () => {
    await boot();
    const host = await join({ create: 'private' });
    const code = host.answer.code!;
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    expect(host.state.room).toEqual({ id: host.answer.roomId, code });
    expect((await get(`?code=${code.toLowerCase()}`)).body).toMatchObject({ roomId: host.answer.roomId, code });
    // Public matchmaking skips it.
    const stranger = await post({ ticket: ticket() });
    expect(stranger.body.roomId).not.toBe(host.answer.roomId);
    const friend = await join({ code: ` ${code.slice(0, 2)}-${code.slice(2)} ` });
    expect(friend.answer.roomId).toBe(host.answer.roomId);
    expect((await post({ ticket: ticket(), code })).status).toBe(403);
    expect((await post({ ticket: ticket(), code: 'ZZZZZ' })).status).toBe(404);
    expect((await get('?code=ZZZZZ')).status).toBe(404);
    const responses: unknown[] = [];
    friend.room.onMessage('response', message => responses.push(message));
    friend.room.send('request', { id: 1, name: 'where' });
    await until(() => responses.length > 0);
    expect(responses[0]).toMatchObject({ ok: true, result: { id: host.answer.roomId, code } });
    const created = await get('?create=private');
    expect(created.body.code).toMatch(/^[A-Z2-9]{5}$/);
    expect(created.body.code).not.toBe(code);
    // Rooms are only created by the game server, never through Colyseus' public routes.
    const forged = await fetch(`${url}/matchmake/create/match-game`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket(), private: true, code: 'AAAAA' }) });
    expect(forged.ok).toBe(false);
  }, 30000);

  test('an empty room closes after a while; a pending reconnection keeps it open', async () => {
    await boot();
    const a = await join();
    const roomId = a.answer.roomId;
    // A dropped connection holds its seat for reconnectSeconds (2 s).
    a.room.reconnection.enabled = false;
    a.room.connection.close();
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(((await admin('rooms')).body as Array<{ id: string }>).map(room => room.id)).toContain(roomId);
    await until(async () => !((await admin('rooms')).body as Array<{ id: string }>).some(room => room.id === roomId), 8000);
    expect((await (await fetch(`${url}/health`)).json()).rooms).toBe(0);
    // Matches never write checkpoint files.
    expect(readdirSync(data).filter(name => name.startsWith('checkpoint'))).toEqual([]);
  }, 30000);

  test('the admin API picks a room by id or code', async () => {
    await boot();
    const a = await join();
    const p = await join({ create: 'private' });
    expect((await admin('players')).status).toBe(400);
    expect((await admin('players')).body.error).toMatch(/2 rooms are running/);
    expect((await admin('players', { room: a.answer.roomId })).body).toHaveLength(1);
    expect((await admin('say', { room: p.answer.code!.toLowerCase(), body: { text: 'hello' } })).body).toEqual({ ok: true });
    expect((await admin('world', { room: p.answer.code })).body.feed.some((item: { text: string }) => item.text === '📣 hello')).toBe(true);
    expect((await admin('players', { room: 'nope' })).status).toBe(404);
    expect((await admin('room', { room: p.answer.roomId })).body).toMatchObject({ id: p.answer.roomId, code: p.answer.code, private: true, mode: 'matches' });
  }, 30000);

  test('GameClient: public matchmaking, private match with an invite link, rejoin after a lost connection', async () => {
    await boot();
    const browser = installBrowser(`${url}/`);
    const host = new GameClient<World>({ game: 'match-game', identity: 'tab', match: { create: 'private' } });
    await host.join('Host');
    await until(() => host.connected && !!host.world);
    expect(host.room?.code).toMatch(/^[A-Z2-9]{5}$/);
    const invite = host.invite!;
    expect(new URL(invite).searchParams.get('code')).toBe(host.room!.code);
    browser.navigate(`${invite}&player=friend`);
    const friend = new GameClient<World>({ game: 'match-game', identity: 'tab' });
    await friend.join('Friend');
    await until(() => friend.connected && !!friend.world?.players[host.id]);
    expect(friend.room).toEqual(host.room);
    browser.navigate(`${url}/?player=solo`);
    const solo = new GameClient<World>({ game: 'match-game', identity: 'tab' });
    await solo.join('Solo');
    await until(() => solo.connected && !!solo.id);
    expect(solo.room?.id).not.toBe(host.room!.id);
    expect(solo.room?.code).toBeUndefined();
    expect(solo.invite).toBeUndefined();
    // The reconnection token is gone (a new page): the client goes back to its room by id.
    const id = solo.id;
    const roomId = solo.room!.id;
    solo.dispose();
    browser.session.delete('gaime:match-game:solo:reconnect');
    const again = new GameClient<World>({ game: 'match-game', identity: 'tab' });
    await again.join('Solo');
    await until(() => again.connected && !!again.id);
    expect(again.room?.id).toBe(roomId);
    expect(again.id).toBe(id);
    // A wrong code is a final error, not an endless retry.
    browser.navigate(`${url}/?code=ZZZZZ&player=lost`);
    const lost = new GameClient<World>({ game: 'match-game', identity: 'tab' });
    const states: string[] = [];
    lost.on('status', state => states.push(state));
    await lost.join('Lost');
    expect(states.at(-1)).toBe('error');
    for (const client of [host, friend, again]) await client.leave();
  }, 30000);

  test('gaime smoke detects matches mode and checks seats and codes', async () => {
    await boot();
    await smoke({ url, cwd: process.cwd() });
  }, 30000);
});

describe('shared mode is unchanged', () => {
  test('one room for everybody; POST and GET agree; lockRoom does nothing', async () => {
    await boot(sharedGame);
    const peek = await get();
    expect(peek.body).toMatchObject({ mode: 'shared' });
    const joined = await Promise.all(Array.from({ length: 4 }, () => join()));
    expect(new Set(joined.map(j => j.answer.roomId))).toEqual(new Set([peek.body.roomId]));
    joined[0].room.send('command', { type: 'lock' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect((await post({ ticket: ticket() })).body.roomId).toBe(peek.body.roomId);
    expect((await admin('players')).body).toHaveLength(4);
    expect((await admin('rooms')).body).toHaveLength(1);
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ ok: true, rooms: 1 });
    const browser = installBrowser(`${url}/?player=web`);
    const client = new GameClient<World>({ game: 'shared-game', identity: 'tab' });
    await client.join('Web');
    await until(() => client.connected && !!client.world);
    expect(client.room).toEqual({ id: peek.body.roomId });
    expect(client.invite).toBeUndefined();
    await client.leave();
    browser.session.clear();
  }, 30000);
});

/** Just enough of a browser page for GameClient in Node: location and web storage. */
function installBrowser(href: string) {
  const storage = () => {
    const map = new Map<string, string>();
    return Object.assign(map, {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, String(value)); },
      removeItem: (key: string) => { map.delete(key); },
    });
  };
  const local = storage();
  const session = storage();
  const globals = globalThis as unknown as Record<string, unknown>;
  const navigate = (next: string) => { globals.location = new URL(next); };
  navigate(href);
  globals.localStorage = local;
  globals.sessionStorage = session;
  return { navigate, local, session };
}

async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error('timeout');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
