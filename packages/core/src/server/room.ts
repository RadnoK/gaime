import { Room, ServerError, Protocol, getMessageBytes, type Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseWorld, Welcome } from '../shared/types';
import { CLOSE_REMOVED, CLOSE_REPLACED } from '../shared/types';
import { JOIN_PROTOCOL, PROTOCOL_VERSION, type RequestMessage, type ResponseMessage } from '../shared/protocol';
import { diffWorld, projectWorld, resolveNetwork, type WorldSnapshot } from '../shared/net';
import { findPlayer, pushFeed } from '../shared/world';
import type { GameDefinition } from './game';
import { cleanName, Engine } from './engine';
import { readCheckpoint, saveCheckpoint } from './persistence';
import { clearError, CREATE_KEY, createSecret, dataDir, markError, runtime, setRoom } from './runtime';
import { normalizeCode, type RoomMetadata } from './matchmaking';
import { recordClients, recordDropped, recordEngine, recordPart, recordPublish, recordThrottle, recordTick, recordTickRate } from './metrics';

type Cache<W> = { world: W; identities: Record<string, string>; sessions: Record<string, string>; batched?: string[]; locked?: boolean };
type Command = { type: string; [key: string]: unknown };
type CreateOptions = { [CREATE_KEY]?: unknown; private?: unknown; code?: unknown };

const TICKET = /^[A-Za-z0-9_-]{16,64}$/;
const SAVE_EVERY_MS = 2000;
const EPHEMERAL = 'gaime-ephemeral';
const BOT = 'gaime-bot';
const BACKPRESSURE_BYTES = 64 * 1024;
/** Ticks the clock may catch up at once after a slow tick; beyond that simulated time is dropped. */
const MAX_CATCH_UP = 3;
/** Client events per player per tick; the rest are dropped (a flood of sounds helps nobody). */
const MAX_EVENTS_PER_CLIENT = 256;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Saved flight recordings of every room in this data directory, newest last. */
export function listRecordings() {
  try { return readdirSync(join(dataDir(), 'replays')).filter(name => name.endsWith('.json')).sort().map(name => join(dataDir(), 'replays', name)); }
  catch { return []; }
}
/** Matches mode: a room with no connection and no pending seat closes after this long. */
const emptyRoomMs = () => {
  const seconds = Number(process.env.GAIME_EMPTY_ROOM_SECONDS || 30);
  return 1000 * (Number.isFinite(seconds) ? Math.max(0, seconds) : 30);
};

/**
 * Builds the room class of a game: the network side of the `Engine` — identities,
 * sessions, reconnection, input leases, the fixed-step clock, delta publishing, batched
 * client events, checkpoints and hot-reload cache/restore.
 *
 * `rooms: shared` (default): one persistent room with a checkpoint. `rooms: matches`: many rooms of
 * `size` seats (Colyseus `maxClients`), ephemeral worlds, optional invite codes, `ctx.lockRoom`,
 * closed when empty for a while (docs/ROOMS.md).
 */
export function createRoomClass<W extends BaseWorld, I>(game: GameDefinition<W, I>) {
  const net = resolveNetwork(game.network);
  const tickRate = game.tickRate ?? 30;
  const stepMs = 1000 / tickRate;
  const publishEvery = Math.max(1, game.publishEvery ?? 2);
  const reconnectSeconds = game.reconnectSeconds ?? 30;
  const inputLeaseMs = game.inputLeaseMs ?? 400;
  const keepPlayers = game.keepPlayers ?? true;
  const maxPlayers = game.maxPlayers ?? Infinity;
  const matches = game.rooms?.mode === 'matches' ? game.rooms : undefined;
  const size = matches ? Math.max(1, Math.floor(matches.size) || 1) : Infinity;
  // The catalog and other shared values are rebuilt by `prepare`; never store them.
  const omit = [...net.shared];

  return class GameRoom extends Room {
    engine: Engine<W, I> = this.createEngine();
    identities: Record<string, string> = {};
    /** sessionId → playerId. */
    sessions: Record<string, string> = {};
    /** Sessions of clients that receive batched `events` (protocol 3+). */
    batched = new Set<string>();
    playerInputs: Record<string, I> = {};
    inputAt: Record<string, number> = {};
    snapshots = new Map<string, WorldSnapshot<W>>();
    /** Client events of the current tick: to everyone, and per player. */
    outbox = { all: [] as Array<[string, unknown]>, to: new Map<string, Array<[string, unknown]>>() };
    droppedEvents = 0;
    revision = 0;
    ticks = 0;
    lag = 0;
    lastSave = 0;
    savedTime = NaN;
    dirty = true;
    publishSoon = false;
    shuttingDown = false;
    game = game;
    /** Matches mode: invite code of a private room. */
    code?: string;
    /** Matches mode: `ctx.lockRoom(true)`. */
    closed = false;
    /** Matches mode: since when the room has no connection and no pending seat. */
    emptySince = 0;
    /** Matches mode: the listing metadata last written to the driver. */
    listed = '';

    lastRecordingSave = 0;

    get world(): W { return this.engine.world; }
    set world(world: W) { this.engine.world = world; }
    get ctx() { return this.engine.ctx; }
    get frozen() { return this.engine.frozen; }

    createEngine(): Engine<W, I> {
      const room = this;
      return new Engine<W, I>(game, {
        notify: (playerId, text) => { for (const client of room.clients) if (room.sessions[client.sessionId] === playerId) client.send('notice', text); },
        send: (name, data, playerId) => {
          if (!playerId) { room.outbox.all.push([name, data]); return; }
          const list = room.outbox.to.get(playerId) ?? [];
          list.push([name, data]);
          room.outbox.to.set(playerId, list);
        },
        disconnect: playerId => room.closePlayer(playerId),
        failed: error => { markError(error, room.roomId); room.publishSoon = true; room.saveRecording('error', true); },
        resumed: () => clearError(room.roomId),
        disabled: (owner, error) => { runtime().disabled[owner] = message(error); room.publishSoon = true; room.saveRecording(`module-${owner}`, true); },
        budget: true,
        throttled: (owner, factor) => recordThrottle(owner, factor),
        record: { minutes: game.record?.minutes ?? 10 },
        changed: () => { room.dirty = true; room.publishSoon = true; },
        profile: recordPart,
        get room() { return room.info(); },
        lockRoom: locked => room.setLocked(locked),
      });
    }

    onCreate(options: CreateOptions = {}) {
      // Rooms come from /gaime/room only — never from Colyseus' public `/matchmake/create` route.
      if (options[CREATE_KEY] !== createSecret()) throw new ServerError(403, 'Rooms are created by the game server (/gaime/room).');
      this.autoDispose = false;
      this.maxMessagesPerSecond = game.maxMessagesPerSecond ?? 90;
      if (matches) this.setupMatch(options);
      setRoom(this);
      recordTickRate(tickRate);
      if (!matches) {
        try {
          const saved = readCheckpoint<W>(game.name);
          if (saved) { this.world = this.engine.load(saved.world); this.identities = saved.identities; }
        } catch (error) {
          this.freeze(error);
        }
      }
      for (const player of Object.values(this.world.players)) player.online = false;
      // Test bots (join option `ephemeral`) never outlive their connection.
      for (const player of Object.values(this.world.players)) if (player.data[EPHEMERAL]) this.release(player.id);
      this.engine.prepare(runtime().loaded);
      if (!keepPlayers) {
        // After a process restart seats wait a minute for their players to come back.
        this.clock.setTimeout(() => {
          const connected = new Set(Object.values(this.sessions));
          for (const player of Object.values(this.world.players)) if (!player.online && !player.data[BOT] && !connected.has(player.id)) this.release(player.id);
          this.persist();
        }, 60_000);
      }

      this.onMessage('hello', client => this.welcome(client));
      this.onMessage('input', (client, payload) => {
        const id = this.sessions[client.sessionId];
        if (!id) return;
        let input: I | undefined;
        try { input = game.parseInput(payload); } catch (error) { console.error('[gaime] parseInput', error); }
        if (input === undefined) return;
        this.playerInputs[id] = input;
        this.inputAt[id] = Date.now();
      });
      this.onMessage('command', (client, payload) => {
        const id = this.sessions[client.sessionId];
        if (!id || !payload || typeof payload !== 'object' || typeof (payload as Command).type !== 'string') return;
        const reply = this.engine.command(id, payload as Command);
        if (typeof reply === 'string' && reply) client.send('notice', reply);
      });
      this.onMessage('request', (client, message: RequestMessage) => void this.request(client, message));

      this.setSimulationInterval(ms => this.tick(ms), stepMs);
    }

    async request(client: Client, message: RequestMessage) {
      const id = this.sessions[client.sessionId];
      if (!id || !message || !Number.isInteger(message.id) || typeof message.name !== 'string') return;
      const reply = (response: Omit<ResponseMessage, 'id'>) => client.send('response', { id: message.id, ...response } satisfies ResponseMessage);
      if (!game.requests?.[message.name]) { reply({ ok: false, error: `Unknown request "${message.name}".` }); return; }
      try { reply({ ok: true, result: await this.engine.request(id, message.name, message.payload) }); }
      catch (error) { console.error(`[gaime] request ${message.name}`, error); reply({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }

    // ── simulation ────────────────────────────────────────────────────

    /** Fixed-step clock: every tick advances exactly 1 / tickRate s; a slow server catches up a little, then slows the game down instead of spiralling. */
    tick(ms: number) {
      const started = performance.now();
      const now = Date.now();
      for (const id of Object.keys(this.playerInputs)) if (now - (this.inputAt[id] ?? 0) > inputLeaseMs) { delete this.playerInputs[id]; delete this.inputAt[id]; }
      this.lag += ms;
      let steps = Math.floor(this.lag / stepMs);
      if (steps > MAX_CATCH_UP) { recordDropped((steps - MAX_CATCH_UP) * stepMs); steps = MAX_CATCH_UP; this.lag = 0; }
      else this.lag -= steps * stepMs;
      // Paused worlds still apply finished jobs.
      if (steps === 0 && this.world.pause) this.engine.applyJobs();
      for (let i = 0; i < steps; i++) this.engine.step(this.playerInputs);
      this.flushEvents();
      recordTick(performance.now() - started);
      // Matches mode: /gaime/stats adds up the clients of every room itself.
      if (!matches) recordClients(this.clients.length);
      const counters = this.engine.counters;
      recordEngine({ ...counters, timersPending: this.world.schedule?.size ?? 0, droppedEvents: this.droppedEvents });
      if (++this.ticks % publishEvery === 0 || this.publishSoon) this.publish();
      if (now - this.lastSave > SAVE_EVERY_MS && (this.dirty || this.world.time !== this.savedTime)) this.persist();
      if (matches && this.ticks % tickRate === 0) this.housekeeping(now);
    }

    /** One message per client per tick with every event of the tick (older clients: one message per event). */
    flushEvents() {
      const { all, to } = this.outbox;
      if (!all.length && !to.size) return;
      for (const client of this.clients) {
        const id = this.sessions[client.sessionId];
        if (!id) continue;
        let list = to.size && to.has(id) ? [...all, ...to.get(id)!] : all;
        if (!list.length) continue;
        if (list.length > MAX_EVENTS_PER_CLIENT) { this.droppedEvents += list.length - MAX_EVENTS_PER_CLIENT; list = list.slice(0, MAX_EVENTS_PER_CLIENT); }
        if (this.batched.has(client.sessionId)) client.send('events', list);
        else for (const [name, data] of list) client.send('event', { name, data });
      }
      this.outbox.all = [];
      to.clear();
    }

    freeze(error: unknown) {
      console.error('[gaime] load', error);
      this.engine.frozen = message(error);
      this.world.pause = { reason: 'error', message: this.engine.frozen };
      pushFeed(this.world, `⚠ The save could not be loaded: ${this.engine.frozen}. The file on disk is left untouched.`);
      markError(error, this.roomId);
    }

    // ── matches ───────────────────────────────────────────────────────

    /** `size` seats, an optional invite code, listing metadata — before the room is listed. */
    setupMatch(options: CreateOptions) {
      this.maxClients = size;
      if (options.private === true) {
        const code = normalizeCode(options.code);
        if (!code) throw new ServerError(400, 'A private match needs an invite code.');
        this.code = code;
        void this.setPrivate(true, false);
      }
      this.listed = JSON.stringify(this.listing());
      void this.setMetadata(this.listing(), false);
    }

    /** What the matchmaker and `gaime rooms` see (kept in the Colyseus listing). */
    listing(): RoomMetadata {
      let players = 0;
      for (const player of Object.values(this.world.players)) if (!player.data[BOT]) players++;
      return { ...(this.code ? { code: this.code } : {}), locked: this.closed, players };
    }

    info(): { id: string; code?: string } {
      return this.code ? { id: this.roomId, code: this.code } : { id: this.roomId ?? 'local' };
    }

    /** Once a second: refresh the listing; close the room when it has stayed empty for a while. */
    housekeeping(now: number) {
      const listing = this.listing();
      const text = JSON.stringify(listing);
      if (text !== this.listed) { this.listed = text; void this.setMetadata(listing); }
      // Seats held for reconnecting players or not yet used keep the room open.
      const pending = Object.keys((this as unknown as { _reservedSeats: object })._reservedSeats).length;
      if (this.clients.length || pending) { this.emptySince = 0; return; }
      this.emptySince ||= now;
      if (now - this.emptySince >= emptyRoomMs() && !this.shuttingDown) void this.disconnect();
    }

    /** `ctx.lockRoom`: a locked room gets no new players from matchmaking or by code; returning players still get in. */
    setLocked(locked: boolean) {
      if (!matches) { console.warn('[gaime] ctx.lockRoom only works with rooms: { mode: "matches" }.'); return; }
      if (this.closed === locked) return;
      this.closed = locked;
      if (locked) void this.lock();
      // A full room stays locked by Colyseus until a seat frees up.
      else if (this.hasReachedMaxClients()) (this as unknown as { _lockedExplicitly: boolean })._lockedExplicitly = false;
      else void this.unlock();
      this.listed = JSON.stringify(this.listing());
      void this.setMetadata(this.listing());
    }

    /** Whether this browser ticket already has a character here (called by the matchmaker, maybe from another process). */
    knows(ticket: string): boolean {
      return typeof ticket === 'string' && !!this.identities[ticket] && !!this.world.players[this.identities[ticket]];
    }

    // ── admin (gaime CLI) ─────────────────────────────────────────────

    admin(action: string, args: Record<string, unknown>): unknown {
      const players = () => Object.values(this.world.players).map(p => ({ id: p.id, name: p.name, online: p.online, host: this.world.hostId === p.id }));
      switch (action) {
        case 'players': return players();
        case 'world': {
          // Operators see everything, the timer queue included.
          const everything = resolveNetwork(game.network);
          everything.hidden.clear();
          return projectWorld(this.world, everything);
        }
        case 'say': this.engine.say(String(args.text ?? '')); this.publishSoon = true; return { ok: true };
        case 'kick': {
          const target = findPlayer(this.world.players, String(args.player ?? ''));
          if (!target) throw new Error(`No player named "${args.player}".`);
          this.ctx.removePlayer(target.id); this.persist(); return { removed: target.name };
        }
        case 'pause': this.engine.setPause({ reason: 'host' }); return { paused: true };
        case 'resume': if (this.frozen) throw new Error('The save did not load — fix the code first.'); this.engine.setPause(null); clearError(this.roomId); return { paused: false };
        case 'save': this.persist(); return { saved: !matches };
        case 'room': return { ...this.info(), clients: this.clients.length, locked: this.closed, private: !!this.code, mode: matches ? 'matches' : 'shared' };
        case 'command': return this.engine.admin(String(args.name ?? ''), Array.isArray(args.args) ? args.args.map(String) : []) ?? { ok: true };
        case 'replay': {
          const file = this.saveRecording(String(args.reason ?? 'manual'));
          if (!file) throw new Error('This game does not record (GameDefinition.record.enabled is false).');
          return { file };
        }
        case 'replays': return listRecordings();
        case 'commands': return Object.fromEntries(Object.entries(game.admin ?? {}).map(([name, command]) => [name, command.description]));
        default: throw new Error(`Unknown action ${action}.`);
      }
    }

    // ── network ───────────────────────────────────────────────────────

    welcome(client: Client) {
      const id = this.sessions[client.sessionId];
      if (!id) return;
      const snapshot = { world: this.viewFor(projectWorld(this.world, net), id), revision: ++this.revision };
      this.snapshots.set(client.sessionId, snapshot);
      client.send('welcome', { id, game: game.name, version: runtime().loaded, protocol: PROTOCOL_VERSION, revision: snapshot.revision, host: this.world.hostId === id, tickRate, room: this.info(), world: snapshot.world } satisfies Welcome & { room: { id: string; code?: string }; world: W });
    }

    /** `GameDefinition.view` applied to a projection (never to the authoritative world). */
    viewFor(projection: W, playerId: string): W {
      if (!game.view) return projection;
      try { return game.view(projection, playerId); }
      catch (error) { console.error('[gaime] view', error); return projection; }
    }

    publish() {
      this.publishSoon = false;
      const started = performance.now();
      let largest = 0;
      let snapshot: WorldSnapshot<W> | undefined;
      // Clients that share a base receive identical bytes: diff and encode once.
      const encoded = new Map<WorldSnapshot<W>, Uint8Array>();
      for (const client of this.clients) {
        if (!this.sessions[client.sessionId]) continue;
        const buffered = (client.ref as unknown as { bufferedAmount?: unknown })?.bufferedAmount;
        if (typeof buffered === 'number' && buffered > BACKPRESSURE_BYTES) continue;
        const previous = this.snapshots.get(client.sessionId);
        if (!previous) { this.welcome(client); continue; }
        snapshot ??= { world: projectWorld(this.world, net), revision: ++this.revision };
        if (game.view) {
          // Per-player views cannot share bytes: diff each client against its own last view.
          const own = { world: this.viewFor(snapshot.world, this.sessions[client.sessionId]), revision: snapshot.revision };
          const patch = diffWorld(previous, own, net);
          client.send('patch', patch);
          this.snapshots.set(client.sessionId, own);
          continue;
        }
        let bytes = encoded.get(previous);
        if (!bytes) {
          const patch = diffWorld(previous, snapshot, net);
          bytes = typeof getMessageBytes?.raw === 'function' ? getMessageBytes.raw(Protocol.ROOM_DATA, 'patch', patch) : undefined;
          if (!bytes) { client.send('patch', patch); this.snapshots.set(client.sessionId, snapshot); continue; }
          encoded.set(previous, bytes);
        }
        client.enqueueRaw(bytes);
        largest = Math.max(largest, bytes.length);
        this.snapshots.set(client.sessionId, snapshot);
      }
      recordPublish(performance.now() - started, largest);
    }

    // ── sessions ──────────────────────────────────────────────────────

    onAuth(client: Client, options: { ticket?: unknown }) {
      // Clients restored after a hot reload re-join with their cached session.
      const restored = this.sessions[client.sessionId];
      if (restored) {
        const ticket = Object.keys(this.identities).find(key => this.identities[key] === restored);
        if (ticket) return { ticket };
      }
      const ticket = options?.ticket;
      if (typeof ticket !== 'string' || !TICKET.test(ticket)) throw new ServerError(400, 'Missing player ticket.');
      const id = this.identities[ticket];
      const existing = id ? this.world.players[id] : undefined;
      if (this.closed && !existing) throw new ServerError(403, 'This match has already started.');
      const players = Object.values(this.world.players).filter(p => !p.data[BOT]);
      const taken = keepPlayers ? players.filter(p => p.online && p.id !== id).length : players.filter(p => p.id !== id).length;
      if ((!existing || keepPlayers) && taken >= maxPlayers) throw new ServerError(403, `The game is full (at most ${maxPlayers} players).`);
      return { ticket };
    }

    onJoin(client: Client, options: { name?: unknown; ephemeral?: unknown; [JOIN_PROTOCOL]?: unknown }, auth: { ticket: string }) {
      const name = typeof options?.name === 'string' ? cleanName(options.name) : '';
      let id = this.identities[auth.ticket];
      if (!id || !this.world.players[id]) {
        id = randomUUID();
        const ephemeral = options?.ephemeral === true;
        const player = this.engine.addPlayer(id, name, ephemeral ? { [EPHEMERAL]: true } : undefined);
        this.identities[auth.ticket] = id;
        if (!ephemeral) pushFeed(this.world, `${player.name} joined the game.`);
      } else if (name && name !== this.world.players[id].name) {
        // Same rule as /nick; a taken name keeps the current one.
        if (this.engine.nameTaken(id, name)) client.send('notice', `The nickname "${name}" is taken — you keep "${this.world.players[id].name}".`);
        else this.engine.setName(id, name);
      }
      if (Number(options?.[JOIN_PROTOCOL]) >= 3) this.batched.add(client.sessionId);
      // The same browser identity opened in another tab takes over the character.
      for (const other of this.clients) {
        if (other.sessionId === client.sessionId || this.sessions[other.sessionId] !== id) continue;
        delete this.sessions[other.sessionId];
        this.snapshots.delete(other.sessionId);
        other.send('notice', 'The game was opened in another tab.');
        other.leave(CLOSE_REPLACED);
      }
      this.sessions[client.sessionId] = id;
      this.setOnline(id, true);
      this.welcome(client);
      this.persist();
    }

    onDrop(client: Client) {
      this.snapshots.delete(client.sessionId);
      this.goOffline(client);
      if (this.shuttingDown) return;
      this.allowReconnection(client, reconnectSeconds).catch(() => {});
    }

    onReconnect(client: Client) {
      const id = this.sessions[client.sessionId];
      if (!id || !this.world.players[id]) { client.leave(CLOSE_REMOVED); return; }
      this.setOnline(id, true);
      this.welcome(client);
    }

    onLeave(client: Client) {
      this.snapshots.delete(client.sessionId);
      this.batched.delete(client.sessionId);
      if (this.shuttingDown) return;
      const id = this.sessions[client.sessionId];
      this.goOffline(client);
      delete this.sessions[client.sessionId];
      if (!id || Object.values(this.sessions).includes(id)) return;
      if (!keepPlayers || this.world.players[id]?.data[EPHEMERAL]) this.release(id);
      this.persist();
    }

    goOffline(client: Client) {
      const id = this.sessions[client.sessionId];
      // Only the socket that currently owns the character controls its presence.
      if (!id || this.clients.some(other => other.sessionId !== client.sessionId && this.sessions[other.sessionId] === id)) return;
      if (this.world.players[id]?.online) this.setOnline(id, false);
    }

    setOnline(id: string, online: boolean) {
      if (!online) { delete this.playerInputs[id]; delete this.inputAt[id]; }
      this.engine.setOnline(id, online);
    }

    release(id: string) {
      delete this.playerInputs[id]; delete this.inputAt[id];
      for (const [ticket, playerId] of Object.entries(this.identities)) if (playerId === id) delete this.identities[ticket];
      this.engine.release(id);
    }

    /** Close every connection of a player the game removed (`ctx.removePlayer`, `/kick`). */
    closePlayer(id: string) {
      for (const client of [...this.clients]) {
        if (this.sessions[client.sessionId] !== id) continue;
        delete this.sessions[client.sessionId];
        this.snapshots.delete(client.sessionId);
        client.send('removed');
        client.leave(CLOSE_REMOVED);
      }
      delete this.playerInputs[id]; delete this.inputAt[id];
      for (const [ticket, playerId] of Object.entries(this.identities)) if (playerId === id) delete this.identities[ticket];
    }

    // ── persistence & hot reload ──────────────────────────────────────

    /** Shared mode: the checkpoint. Worlds of matches are ephemeral (hot reloads keep them in memory). */
    persist() {
      if (this.frozen || matches) return;
      try {
        saveCheckpoint(game.name, this.world, this.identities, omit);
        this.savedTime = this.world.time; this.dirty = false; this.lastSave = Date.now();
      } catch (error) { console.error('[gaime] checkpoint', error); }
    }

    /**
     * Writes the flight recording to `<data>/replays/`. Automatic saves (errors, a module switched
     * off) happen at most once a minute per room; the newest 20 files are kept.
     */
    saveRecording(reason: string, automatic = false): string | undefined {
      const recorder = this.engine.recorder;
      if (!recorder || (automatic && Date.now() - this.lastRecordingSave < 60_000)) return undefined;
      this.lastRecordingSave = Date.now();
      try {
        const dir = join(dataDir(), 'replays');
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = join(dir, `${stamp}-${matches ? `${this.roomId}-` : ''}${reason.replace(/[^\w-]+/g, '-').slice(0, 40)}.json`);
        writeFileSync(file, JSON.stringify(recorder.toJSON(game, runtime().loaded, reason)));
        for (const old of readdirSync(dir).filter(name => name.endsWith('.json')).sort().slice(0, -20)) rmSync(join(dir, old), { force: true });
        if (automatic) console.log(`[gaime] replay saved: ${file}`);
        return file;
      } catch (error) { console.error('[gaime] replay', error); return undefined; }
    }

    onCacheRoom(): Cache<W> {
      this.shuttingDown = true;
      this.persist();
      this.engine.dispose();
      return { world: this.world, identities: this.identities, sessions: this.sessions, batched: [...this.batched], locked: this.closed };
    }

    onRestoreRoom(cache?: Cache<W>) {
      if (!cache) return;
      this.identities = cache.identities ?? {};
      this.sessions = cache.sessions ?? {};
      this.batched = new Set(cache.batched ?? []);
      this.playerInputs = {}; this.inputAt = {}; this.snapshots.clear();
      try {
        this.world = this.engine.load(cache.world);
        this.engine.frozen = null;
        clearError(this.roomId);
        pushFeed(this.world, `♻ New game code loaded (${runtime().loaded.slice(0, 8)}).`);
      } catch (error) {
        // Keep the real state visible and untouched; the previous code can still read it.
        this.world = cache.world;
        this.freeze(error);
      }
      for (const player of Object.values(this.world.players)) player.online = false;
      this.engine.prepare(runtime().loaded);
      if (cache.locked) this.setLocked(true);
    }

    onBeforeShutdown() {
      this.shuttingDown = true;
      this.persist();
      super.onBeforeShutdown();
    }

    onDispose() {
      this.persist();
      this.engine.dispose();
      setRoom(undefined, this);
    }
  };
}
