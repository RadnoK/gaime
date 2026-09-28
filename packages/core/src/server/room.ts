import { Room, ServerError, Protocol, getMessageBytes, type Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import type { BaseWorld, Welcome } from '../shared/types';
import { CLOSE_REMOVED, CLOSE_REPLACED } from '../shared/types';
import { JOIN_PROTOCOL, PROTOCOL_VERSION, type RequestMessage, type ResponseMessage } from '../shared/protocol';
import { diffWorld, projectWorld, resolveNetwork, type WorldSnapshot } from '../shared/net';
import { findPlayer, pushFeed } from '../shared/world';
import type { GameDefinition } from './game';
import { cleanName, Engine } from './engine';
import { readCheckpoint, saveCheckpoint } from './persistence';
import { clearError, markError, runtime, setRoom } from './runtime';
import { recordClients, recordDropped, recordEngine, recordPart, recordPublish, recordTick, recordTickRate } from './metrics';

type Cache<W> = { world: W; identities: Record<string, string>; sessions: Record<string, string>; batched?: string[] };
type Command = { type: string; [key: string]: unknown };

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

/**
 * Builds the single shared room of a game: the network side of the `Engine` — identities,
 * sessions, reconnection, input leases, the fixed-step clock, delta publishing, batched
 * client events, checkpoints and hot-reload cache/restore.
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

    get world(): W { return this.engine.world; }
    set world(world: W) { this.engine.world = world; }
    get ctx() { return this.engine.ctx; }
    get frozen() { return this.engine.frozen; }

    createEngine(): Engine<W, I> {
      const room = this;
      runtime().disabled = {};
      return new Engine<W, I>(game, {
        notify: (playerId, text) => { for (const client of room.clients) if (room.sessions[client.sessionId] === playerId) client.send('notice', text); },
        send: (name, data, playerId) => {
          if (!playerId) { room.outbox.all.push([name, data]); return; }
          const list = room.outbox.to.get(playerId) ?? [];
          list.push([name, data]);
          room.outbox.to.set(playerId, list);
        },
        disconnect: playerId => room.closePlayer(playerId),
        failed: error => { markError(error); room.publishSoon = true; },
        resumed: () => clearError(),
        disabled: (owner, error) => { runtime().disabled[owner] = message(error); room.publishSoon = true; },
        changed: () => { room.dirty = true; room.publishSoon = true; },
        profile: recordPart,
      });
    }

    onCreate() {
      this.autoDispose = false;
      this.maxMessagesPerSecond = game.maxMessagesPerSecond ?? 90;
      setRoom(this);
      recordTickRate(tickRate);
      try {
        const saved = readCheckpoint<W>(game.name);
        if (saved) { this.world = this.engine.load(saved.world); this.identities = saved.identities; }
      } catch (error) {
        this.freeze(error);
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
      const handler = game.requests?.[message.name];
      if (!handler) { reply({ ok: false, error: `Unknown request "${message.name}".` }); return; }
      try { reply({ ok: true, result: await this.engine.outside(() => handler(this.world, id, message.payload, this.ctx)) }); }
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
      recordClients(this.clients.length);
      const counters = this.engine.counters;
      recordEngine({ ...counters, timersPending: this.world.schedule?.size ?? 0, droppedEvents: this.droppedEvents });
      if (++this.ticks % publishEvery === 0 || this.publishSoon) this.publish();
      if (now - this.lastSave > SAVE_EVERY_MS && (this.dirty || this.world.time !== this.savedTime)) this.persist();
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
      markError(error);
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
        case 'say': pushFeed(this.world, `📣 ${String(args.text ?? '').slice(0, 280)}`); this.publishSoon = true; return { ok: true };
        case 'kick': {
          const target = findPlayer(this.world.players, String(args.player ?? ''));
          if (!target) throw new Error(`No player named "${args.player}".`);
          this.ctx.removePlayer(target.id); this.persist(); return { removed: target.name };
        }
        case 'pause': this.world.pause = { reason: 'host' }; return { paused: true };
        case 'resume': if (this.frozen) throw new Error('The save did not load — fix the code first.'); this.world.pause = null; clearError(); return { paused: false };
        case 'save': this.persist(); return { saved: true };
        case 'command': {
          const name = String(args.name ?? '');
          const command = game.admin?.[name];
          if (!command) throw new Error(`Unknown admin command "${name}". Available: ${Object.keys(game.admin ?? {}).join(', ') || 'none'}`);
          const result = this.engine.outside(() => command.run(this.world, Array.isArray(args.args) ? args.args.map(String) : [], this.ctx));
          return result ?? { ok: true };
        }
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
      client.send('welcome', { id, game: game.name, version: runtime().loaded, protocol: PROTOCOL_VERSION, revision: snapshot.revision, host: this.world.hostId === id, tickRate, world: snapshot.world } satisfies Welcome & { world: W });
    }

    /** `GameDefinition.view` applied to a projection (never to the authoritative world). */
    viewFor(projection: W, playerId: string): W {
      if (!game.view) return projection;
      try { return game.view(projection, playerId); }
      catch (error) { console.error('[gaime] view', error); return projection; }
    }

    publish() {
      this.publishSoon = false;
      this.engine.ensureHost();
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
        const player = this.engine.addPlayer(id, name);
        this.identities[auth.ticket] = id;
        if (options?.ephemeral === true) player.data[EPHEMERAL] = true;
        else pushFeed(this.world, `${player.name} joined the game.`);
      } else if (name && name !== this.world.players[id].name) {
        // Same rule as /nick; a taken name keeps the current one.
        if (this.engine.nameTaken(id, name)) client.send('notice', `The nickname "${name}" is taken — you keep "${this.world.players[id].name}".`);
        else this.world.players[id].name = name;
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

    persist() {
      if (this.frozen) return;
      try {
        saveCheckpoint(game.name, this.world, this.identities, omit);
        this.savedTime = this.world.time; this.dirty = false; this.lastSave = Date.now();
      } catch (error) { console.error('[gaime] checkpoint', error); }
    }

    onCacheRoom(): Cache<W> {
      this.shuttingDown = true;
      this.persist();
      return { world: this.world, identities: this.identities, sessions: this.sessions, batched: [...this.batched] };
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
        clearError();
        pushFeed(this.world, `♻ New game code loaded (${runtime().loaded.slice(0, 8)}).`);
      } catch (error) {
        // Keep the real state visible and untouched; the previous code can still read it.
        this.world = cache.world;
        this.freeze(error);
      }
      for (const player of Object.values(this.world.players)) player.online = false;
      this.engine.prepare(runtime().loaded);
    }

    onBeforeShutdown() {
      this.shuttingDown = true;
      this.persist();
      super.onBeforeShutdown();
    }

    onDispose() {
      this.persist();
      setRoom(undefined, this);
    }
  };
}
