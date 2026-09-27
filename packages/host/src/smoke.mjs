// Game-agnostic end-to-end check with real WebSocket clients against a running game.
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

  async function connect(name, id = ticket()) {
    const { roomId } = await (await fetch(`${url}/gaime/room`)).json();
    const client = new Client(url);
    const room = await client.joinById(roomId, { name, ticket: id, ephemeral: true });
    rooms.push(room);
    const state = { id: '', world: null, welcomes: 0, reconnects: 0, left: null, client, ticket: id };
    room.reconnection.minUptime = 0;
    room.onMessage('welcome', data => { state.id = data.id; state.world = data.world; state.revision = data.revision; state.welcomes++; });
    room.onMessage('patch', patch => { if (!applyPatch(state, patch)) room.send('hello'); });
    room.onMessage('notice', () => {});
    room.onMessage('removed', () => {});
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
    const a = await connect('Smoke A');
    const b = await connect('Smoke B');
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
    restored.onMessage('patch', () => {});
    restored.send('hello');
    await wait(() => again.id === a.state.id, 'A reconnects as the same player');
    await wait(() => b.state.world.players[a.state.id]?.online === true, 'B sees A online again');
    console.log('✓ drop + reconnect keeps the identity');

    const tab = await connect('Smoke A (new tab)', a.state.ticket);
    assert.equal(tab.state.id, a.state.id, 'same ticket → same player');
    console.log('✓ same browser identity takes over the character');

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
