// Game-agnostic end-to-end check with real WebSocket clients against a running game.
// Shared games: one room. Matches mode (detected from /gaime/room): seats, invite codes, matchmaking.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { utimesSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ticket = () => randomBytes(18).toString('base64url');

export async function smoke({ url = 'http://localhost:5173', hmr = false, cwd = process.cwd() } = {}) {
  const require = createRequire(join(cwd, 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@colyseus/sdk')).href);
  const rooms = [];
  const wait = async (test, what, timeout = 10000) => {
    const started = Date.now();
    while (!test()) {
      if (Date.now() - started > timeout) throw new Error(`Timeout: ${what}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const health = async () => (await fetch(`${url}/health`, { cache: 'no-store' })).json();

  // Matches mode: a seat reservation from POST /gaime/room (what GameClient does); `match`: { code } | { create: 'private' } | { room }.
  async function reserve(client, name, id, match) {
    const response = await fetch(`${url}/gaime/room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ticket: id, ephemeral: true, ...match }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(`POST /gaime/room: ${response.status} ${answer.error ?? ''}`);
    return { answer, room: await client.consumeSeatReservation(answer.reservation) };
  }

  async function connect(name, id = ticket(), match) {
    const client = new Client(url);
    let room, roomId, code;
    if (match) ({ room, answer: { roomId, code } } = await reserve(client, name, id, match));
    else {
      ({ roomId } = await (await fetch(`${url}/gaime/room`)).json());
      room = await client.joinById(roomId, { name, ticket: id, ephemeral: true });
    }
    rooms.push(room);
    const state = { id: '', world: null, welcomes: 0, reconnects: 0, left: null, client, ticket: id, roomId, code };
    room.reconnection.minUptime = 0;
    room.onMessage('welcome', data => { state.id = data.id; state.world = data.world; state.revision = data.revision; state.welcomes++; });
    room.onMessage('patch', patch => { if (!applyPatch(state, patch)) room.send('hello'); });
    for (const type of ['notice', 'removed', 'event', 'events', 'response']) room.onMessage(type, () => {});
    room.onReconnect(() => { state.reconnects++; room.send('hello'); });
    room.onLeave(code => { state.left = code; });
    await wait(() => state.id && state.world, `${name}: welcome`);
    return { room, state };
  }

  // Minimal patch application (same algorithm as @gaime/core applyWorldPatch).
  function applyPatch(state, patch) {
    if (!state.world || patch.base !== state.revision) return false;
    const world = { ...state.world, ...patch.values };
    for (const key of patch.removed ?? []) delete world[key];
    for (const [key, change] of Object.entries(patch.entities ?? {})) {
      const dict = { ...world[key] };
      for (const id of change.remove ?? []) delete dict[id];
      for (const [id, fields] of Object.entries(change.upsert ?? {})) dict[id] = { ...dict[id], ...fields };
      world[key] = dict;
    }
    for (const [key, change] of Object.entries(patch.streams ?? {})) {
      const removed = new Set(change.remove);
      world[key] = [...world[key].filter(item => !removed.has(item.id)), ...change.add];
    }
    state.world = world; state.revision = patch.revision;
    return true;
  }

  try {
    const before = await health();
    assert.equal(before.ok, true, `health: ${JSON.stringify(before)}`);
    const peek = await (await fetch(`${url}/gaime/room`, { cache: 'no-store' })).json();
    const matches = peek.mode === 'matches';
    const size = matches ? peek.size : Infinity;
    if (matches) {
      console.log(`matches mode: rooms of ${size}`);
      if (size < 2) {
        const solo = await connect('Smoke solo', ticket(), {});
        assert(solo.state.world, 'welcome in a one-seat match');
        console.log('✓ one-seat match: welcome snapshot (multi-client checks need rooms of 2+)');
        console.log('PASS');
        return;
      }
    }
    // Matches: A and B meet in a private match (other players cannot take their seats).
    const a = matches ? await connect('Smoke A', ticket(), { create: 'private' }) : await connect('Smoke A');
    const b = matches ? await connect('Smoke B', ticket(), { code: a.state.code.toLowerCase() }) : await connect('Smoke B');
    if (matches) {
      assert.match(a.state.code ?? '', /^[A-Z0-9]{4,12}$/, 'a private match gets an invite code');
      assert.equal(b.state.roomId, a.state.roomId, 'the invite code leads into the same room');
      const byCode = await (await fetch(`${url}/gaime/room?code=${a.state.code}`)).json();
      assert.equal(byCode.roomId, a.state.roomId, 'GET /gaime/room?code= finds the room');
      console.log(`✓ private match ${a.state.code}: create + join by invite code`);
    }
    await wait(() => a.state.world.players[b.state.id]?.online, 'A sees B online (entity patch)');
    console.log('✓ two clients, welcome snapshot and entity patches');

    const text = `smoke ${Date.now()}`;
    a.room.send('command', { type: '$chat', text });
    await wait(() => b.state.world.feed.some(item => item.text === text && item.from === a.state.id), 'B receives chat (stream patch)');
    console.log('✓ commands and stream patches');

    const token = a.room.reconnectionToken;
    a.room.reconnection.enabled = false;
    a.room.connection.close();
    await wait(() => b.state.world.players[a.state.id]?.online === false, 'B sees A offline after a drop');
    const restored = await a.state.client.reconnect(token);
    rooms.push(restored);
    const again = { id: '', world: null };
    restored.onMessage('welcome', data => { again.id = data.id; again.world = data.world; });
    for (const type of ['patch', 'notice', 'event', 'events', 'response']) restored.onMessage(type, () => {});
    restored.send('hello');
    await wait(() => again.id === a.state.id, 'A reconnects as the same player');
    await wait(() => b.state.world.players[a.state.id]?.online === true, 'B sees A online again');
    console.log('✓ drop + reconnect keeps the identity');

    if (!matches) {
      const tab = await connect('Smoke A (new tab)', a.state.ticket);
      assert.equal(tab.state.id, a.state.id, 'same ticket → same player');
    } else {
      // The room of A and B is full with 2 seats: take over a character in a room of its own.
      const t = ticket();
      const f = await connect('Smoke F', t, { create: 'private' });
      const tab = await connect('Smoke F (new tab)', t, { code: f.state.code });
      assert.equal(tab.state.id, f.state.id, 'same ticket → same player');
    }
    console.log('✓ same browser identity takes over the character');

    if (matches) {
      const c = await connect('Smoke C', ticket(), {});
      const d = await connect('Smoke D', ticket(), {});
      assert.notEqual(c.state.roomId, a.state.roomId, 'public matchmaking never picks a private match');
      if (c.state.roomId === d.state.roomId) {
        console.log('✓ public matchmaking puts two players in the same room');
        if (size === 2) {
          const e = await connect('Smoke E', ticket(), {});
          assert.notEqual(e.state.roomId, c.state.roomId, 'a full room takes nobody else');
          console.log('✓ a third player gets a new room when the first one is full');
        }
      } else console.log('✓ public matchmaking (C and D landed in different rooms: other players took the free seat)');
    }

    if (hmr) {
      const entry = resolve(cwd, 'src/server/index.ts');
      assert(existsSync(entry), `${entry} not found (run from the game directory)`);
      const welcomes = b.state.welcomes;
      const now = new Date(); utimesSync(entry, now, now);
      await wait(() => b.state.welcomes > welcomes, 'B gets a fresh welcome after the backend hot reload', 20000);
      const ids = [a.state.id, b.state.id];
      await wait(() => b.state.world.feed.some(item => /New game code/.test(item.text)), 'reload notice in the feed');
      assert.equal(b.state.id, ids[1], 'identity survives HMR');
      await wait(() => b.state.world.players[ids[1]]?.online, 'B online again after HMR');
      assert.equal((await health()).ok, true);
      console.log('✓ backend hot reload keeps the room, world and identities');
    }
    console.log('PASS');
  } finally {
    for (const room of rooms) {
      room.reconnection.enabled = false;
      try { if (room.connection.isOpen) await room.leave(true); } catch {}
    }
  }
}
