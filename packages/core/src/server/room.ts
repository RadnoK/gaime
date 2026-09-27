import { Room, ServerError, Protocol, getMessageBytes, type Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import type { BasePlayer, BaseWorld, PlayerOf, Welcome } from '../shared/types';
import { CLOSE_REMOVED, CLOSE_REPLACED } from '../shared/types';
import { PROTOCOL_VERSION, type RequestMessage, type ResponseMessage } from '../shared/protocol';
import { diffWorld, projectWorld, resolveNetwork, type WorldSnapshot } from '../shared/net';
import { findPlayer, hydrate, nextId, pushFeed } from '../shared/world';
import type { GameContext, GameDefinition } from './game';
import { createChat } from './chat';
import { readCheckpoint, saveCheckpoint } from './persistence';
import { clearError, markError, runtime, setRoom } from './runtime';
import { recordClients, recordPublish, recordTick } from './metrics';

type Cache<W> = { world: W; identities: Record<string, string>; sessions: Record<string, string> };
type Command = { type: string; [key: string]: unknown };
type Job<W extends BaseWorld> = { apply: (world: W, result: unknown, ctx: GameContext<W>) => void; fail?: (world: W, error: Error, ctx: GameContext<W>) => void; result?: unknown; error?: Error };

const TICKET = /^[A-Za-z0-9_-]{16,64}$/;
const SAVE_EVERY_MS = 2000;
const EPHEMERAL = 'gaime-ephemeral';
const BOT = 'gaime-bot';
const BACKPRESSURE_BYTES = 64 * 1024;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Builds the single shared room of a game. Everything that is not game rules lives here:
 * identities, reconnection, host role, input leases, delta publishing, checkpoints,
 * hot-reload cache/restore and error isolation.
 */
export function createRoomClass<W extends BaseWorld, I>(game: GameDefinition<W, I>) {
  const net = resolveNetwork(game.network);
  const tickRate = game.tickRate ?? 30;
  const publishEvery = Math.max(1, game.publishEvery ?? 2);
  const reconnectSeconds = game.reconnectSeconds ?? 30;
  const inputLeaseMs = game.inputLeaseMs ?? 400;
  const keepPlayers = game.keepPlayers ?? true;
  const maxPlayers = game.maxPlayers ?? Infinity;
  // The catalog and other shared values are rebuilt by `prepare`; never store them.
  const omit = [...net.shared];

  return class GameRoom extends Room {
    world: W = game.createWorld();
    identities: Record<string, string> = {};
    /** sessionId → playerId. */
    sessions: Record<string, string> = {};
    playerInputs: Record<string, I> = {};
    inputAt: Record<string, number> = {};
    snapshots = new Map<string, WorldSnapshot<W>>();
    revision = 0;
    ticks = 0;
    lastSave = 0;
    savedTime = NaN;
    dirty = true;
    publishSoon = false;
    shuttingDown = false;
    /** Set when a save could not be loaded: never overwrite the good checkpoint on disk. */
    frozen: string | null = null;
    ctx: GameContext<W> = this.context();
    /** Finished async jobs waiting to be applied on the next tick. */
    jobs: Job<W>[] = [];
    game = game;
    chat = createChat(game as GameDefinition<W, unknown>, {
      ctx: this.ctx,
      bots: !!game.bot,
      rename: (id, name) => this.rename(id, name),
      pause: (id, paused) => this.engineCommand(id, { type: paused ? '$pause' : '$resume' }),
    });

    onCreate() {
      this.autoDispose = false;
      this.maxMessagesPerSecond = game.maxMessagesPerSecond ?? 90;
      setRoom(this);
      try {
        const saved = readCheckpoint<W>(game.name);
        if (saved) { this.world = this.load(saved.world); this.identities = saved.identities; }
      } catch (error) {
        this.freeze(error);
      }
      for (const player of Object.values(this.world.players)) player.online = false;
      // Test bots (join option `ephemeral`) never outlive their connection.
      for (const player of Object.values(this.world.players)) if (player.data[EPHEMERAL]) this.release(player.id);
      this.prepare();
      if (!keepPlayers) {
        // After a process restart seats wait a minute for their players to come back.
        this.clock.setTimeout(() => {
          const connected = new Set(Object.values(this.sessions));
          for (const player of Object.values(this.world.players)) if (!player.online && !connected.has(player.id)) this.release(player.id);
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
        const command = payload as Command;
        this.dirty = true; this.publishSoon = true;
        let reply: string | void;
        try { reply = command.type.startsWith('$') ? this.engineCommand(id, command) : game.command?.(this.world, id, command, this.ctx); }
        catch (error) {
          console.error(`[gaime] command ${command.type}`, error);
          reply = `Error in the code of command "${command.type}": ${message(error)}`;
        }
        if (typeof reply === 'string' && reply) client.send('notice', reply);
      });

      this.onMessage('request', (client, message: RequestMessage) => void this.request(client, message));

      this.setSimulationInterval(ms => this.tick(ms), 1000 / tickRate);
    }

    async request(client: Client, message: RequestMessage) {
      const id = this.sessions[client.sessionId];
      if (!id || !message || !Number.isInteger(message.id) || typeof message.name !== 'string') return;
      const reply = (response: Omit<ResponseMessage, 'id'>) => client.send('response', { id: message.id, ...response } satisfies ResponseMessage);
      const handler = game.requests?.[message.name];
      if (!handler) { reply({ ok: false, error: `Unknown request "${message.name}".` }); return; }
      try { reply({ ok: true, result: await handler(this.world, id, message.payload, this.ctx) }); }
      catch (error) { console.error(`[gaime] request ${message.name}`, error); reply({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    }

    // ── simulation ────────────────────────────────────────────────────

    tick(ms: number) {
      const started = performance.now();
      const now = Date.now();
      for (const id of Object.keys(this.playerInputs)) if (now - (this.inputAt[id] ?? 0) > inputLeaseMs) { delete this.playerInputs[id]; delete this.inputAt[id]; }
      if (this.jobs.length) {
        for (const job of this.jobs.splice(0)) {
          try {
            if (job.error) job.fail?.(this.world, job.error, this.ctx);
            else job.apply(this.world, job.result, this.ctx);
          } catch (error) { this.fail(error); }
        }
        this.dirty = true;
      }
      if (game.bot && !this.world.pause) {
        for (const player of Object.values(this.world.players)) {
          if (!player.data[BOT]) continue;
          try {
            const input = game.bot(this.world, player.id, this.ctx);
            if (input !== undefined) { this.playerInputs[player.id] = input; this.inputAt[player.id] = now; }
          } catch (error) { this.fail(error); break; }
        }
      }
      if (!this.world.pause) {
        const dt = Math.min(ms / 1000, 0.1);
        this.world.time += dt;
        try { game.step(this.world, this.playerInputs, dt, this.ctx); }
        catch (error) { this.fail(error); }
      }
      recordTick(performance.now() - started);
      recordClients(this.clients.length);
      if (++this.ticks % publishEvery === 0 || this.publishSoon) this.publish();
      if (now - this.lastSave > SAVE_EVERY_MS && (this.dirty || this.world.time !== this.savedTime)) this.persist();
    }

    /** A thrown error pauses the game instead of crashing the process; the next hot reload resumes it. */
    fail(error: unknown) {
      console.error('[gaime] simulation', error);
      this.world.pause = { reason: 'error', message: message(error) };
      pushFeed(this.world, `⚠ Game code error: ${message(error)}. The game is paused — push a fix, new code resumes it.`);
      markError(error);
      this.publishSoon = true;
    }

    freeze(error: unknown) {
      console.error('[gaime] load', error);
      this.frozen = message(error);
      this.world.pause = { reason: 'error', message: this.frozen };
      pushFeed(this.world, `⚠ The save could not be loaded: ${this.frozen}. The file on disk is left untouched.`);
      markError(error);
    }

    engineCommand(id: string, command: Command): string | void {
      const player = this.world.players[id];
      if (command.type === '$chat') return this.chat(this.world, id, command.text);
      if (command.type === '$pause' || command.type === '$resume') {
        if (this.world.hostId !== id) return 'Only the host can pause or resume the game.';
        if (this.frozen) return 'The save did not load — fix the code first.';
        this.world.pause = command.type === '$pause' ? { reason: 'host' } : null;
        if (command.type === '$resume') clearError();
        pushFeed(this.world, `${player.name} ${command.type === '$pause' ? 'paused' : 'resumed'} the game.`);
        return;
      }
      return `Unknown command ${command.type}.`;
    }

    // ── engine context ────────────────────────────────────────────────

    context(): GameContext<W> {
      const room = this;
      return {
        get world() { return room.world; },
        log: text => { pushFeed(room.world, text); },
        notify: (playerId, text) => {
          for (const client of room.clients) if (room.sessions[client.sessionId] === playerId) client.send('notice', text);
        },
        nextId: () => nextId(room.world),
        random: Math.random,
        isHost: playerId => room.world.hostId === playerId,
        removePlayer: playerId => room.removePlayer(playerId),
        save: () => { room.dirty = true; room.lastSave = 0; },
        emit: (name, data, playerId) => {
          if (!playerId) { room.broadcast('event', { name, data }); return; }
          for (const client of room.clients) if (room.sessions[client.sessionId] === playerId) client.send('event', { name, data });
        },
        job: (work, apply, fail) => {
          const job: Job<W> = { apply: apply as Job<W>['apply'], fail };
          work.then(result => { job.result = result; room.jobs.push(job); }, error => { job.error = error instanceof Error ? error : new Error(String(error)); room.jobs.push(job); });
        },
        findPlayer: query => findPlayer(room.world.players, query) as PlayerOf<W> | undefined,
        addBot: name => room.addBot(name),
        isBot: playerId => !!room.world.players[playerId]?.data[BOT],
        command: (playerId, command) => game.command?.(room.world, playerId, command, room.ctx),
      };
    }

    addBot(name?: string): string {
      if (!game.bot) throw new Error('This game has no bot() brain (GameDefinition.bot).');
      const id = `bot-${randomUUID().slice(0, 8)}`;
      const count = Object.values(this.world.players).filter(p => p.data[BOT]).length;
      const player = game.createPlayer(this.world, id, name || `Bot ${count + 1}`, this.ctx);
      player.data[BOT] = true;
      player.online = true;
      this.world.players[id] = player;
      pushFeed(this.world, `🤖 ${player.name} joined the game.`);
      try { game.onPlayerOnline?.(this.world, player, true, this.ctx); } catch (error) { this.fail(error); }
      this.dirty = true; this.publishSoon = true;
      return id;
    }

    rename(id: string, raw: string): string | void {
      const name = raw.replace(/\s+/g, ' ').trim().slice(0, 24);
      const player = this.world.players[id];
      if (!player || !name) return 'Usage: /nick <new nick>';
      if (Object.values(this.world.players).some(other => other.id !== id && other.name.toLowerCase() === name.toLowerCase())) return `The nickname "${name}" is taken.`;
      pushFeed(this.world, `${player.name} is now known as ${name}.`);
      player.name = name;
      this.dirty = true;
    }

    // ── admin (gaime CLI) ─────────────────────────────────────────────

    admin(action: string, args: Record<string, unknown>): unknown {
      const players = () => Object.values(this.world.players).map(p => ({ id: p.id, name: p.name, online: p.online, host: this.world.hostId === p.id }));
      switch (action) {
        case 'players': return players();
        case 'world': return projectWorld(this.world, resolveNetwork({ ...game.network, hidden: [] }));
        case 'say': pushFeed(this.world, `📣 ${String(args.text ?? '').slice(0, 280)}`); this.publishSoon = true; return { ok: true };
        case 'kick': {
          const target = findPlayer(this.world.players, String(args.player ?? ''));
          if (!target) throw new Error(`No player named "${args.player}".`);
          this.removePlayer(target.id); return { removed: target.name };
        }
        case 'pause': this.world.pause = { reason: 'host' }; return { paused: true };
        case 'resume': if (this.frozen) throw new Error('The save did not load — fix the code first.'); this.world.pause = null; clearError(); return { paused: false };
        case 'save': this.persist(); return { saved: true };
        case 'command': {
          const name = String(args.name ?? '');
          const command = game.admin?.[name];
          if (!command) throw new Error(`Unknown admin command "${name}". Available: ${Object.keys(game.admin ?? {}).join(', ') || 'none'}`);
          const result = command.run(this.world, Array.isArray(args.args) ? args.args.map(String) : [], this.ctx);
          this.dirty = true; this.publishSoon = true;
          return result ?? { ok: true };
        }
        case 'commands': return Object.fromEntries(Object.entries(game.admin ?? {}).map(([name, command]) => [name, command.description]));
        default: throw new Error(`Unknown action ${action}.`);
      }
    }

    /** Fill new fields from defaults, then the game's explicit migration. */
    load(raw: unknown): W {
      const scratch = game.createWorld();
      const template = game.createPlayer(scratch, 'template', 'template', { ...this.ctx, world: scratch, log() {}, notify() {} } as GameContext<W>) as BasePlayer;
      const world = hydrate(structuredClone(raw), game.createWorld(), template);
      return game.migrate ? game.migrate(world) : world;
    }

    prepare() {
      this.world.version = runtime().loaded;
      if (!this.frozen && this.world.pause?.reason === 'error') this.world.pause = null;
      // Bots have no connection to come back with: they are online whenever the room runs.
      for (const player of Object.values(this.world.players)) if (player.data[BOT]) player.online = true;
      try { game.prepare?.(this.world, this.ctx); } catch (error) { this.fail(error); }
      this.ensureHost();
    }

    ensureHost() {
      const current = this.world.hostId ? this.world.players[this.world.hostId] : undefined;
      if (current?.online && !current.data[BOT]) return;
      const next = Object.values(this.world.players).find(player => player.online && !player.data[BOT]);
      this.world.hostId = next?.id ?? null;
    }

    // ── network ───────────────────────────────────────────────────────

    welcome(client: Client) {
      const id = this.sessions[client.sessionId];
      if (!id) return;
      const snapshot = { world: projectWorld(this.world, net), revision: ++this.revision };
      this.snapshots.set(client.sessionId, snapshot);
      client.send('welcome', { id, game: game.name, version: runtime().loaded, protocol: PROTOCOL_VERSION, revision: snapshot.revision, host: this.world.hostId === id, world: snapshot.world } satisfies Welcome & { world: W });
    }

    publish() {
      this.publishSoon = false;
      this.ensureHost();
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

    onJoin(client: Client, options: { name?: unknown; ephemeral?: unknown }, auth: { ticket: string }) {
      const name = typeof options?.name === 'string' ? options.name.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
      let id = this.identities[auth.ticket];
      if (!id || !this.world.players[id]) {
        id = randomUUID();
        this.world.players[id] = game.createPlayer(this.world, id, name || `Player ${Object.keys(this.world.players).length + 1}`, this.ctx);
        this.identities[auth.ticket] = id;
        if (options?.ephemeral === true) this.world.players[id].data[EPHEMERAL] = true;
        else pushFeed(this.world, `${this.world.players[id].name} joined the game.`);
      } else if (name && name !== this.world.players[id].name) {
        this.world.players[id].name = name;
      }
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
      const player = this.world.players[id] as PlayerOf<W> | undefined;
      if (!player) return;
      player.online = online;
      if (!online) { delete this.playerInputs[id]; delete this.inputAt[id]; }
      try { game.onPlayerOnline?.(this.world, player, online, this.ctx); } catch (error) { this.fail(error); }
      this.ensureHost();
      this.dirty = true; this.publishSoon = true;
    }

    release(id: string) {
      const player = this.world.players[id] as PlayerOf<W> | undefined;
      if (!player) return;
      try { game.onPlayerRemoved?.(this.world, player, this.ctx); } catch (error) { this.fail(error); }
      delete this.world.players[id];
      delete this.playerInputs[id]; delete this.inputAt[id];
      for (const [ticket, playerId] of Object.entries(this.identities)) if (playerId === id) delete this.identities[ticket];
      this.ensureHost();
      this.dirty = true; this.publishSoon = true;
    }

    removePlayer(id: string) {
      const player = this.world.players[id];
      if (!player) return;
      for (const client of [...this.clients]) {
        if (this.sessions[client.sessionId] !== id) continue;
        delete this.sessions[client.sessionId];
        this.snapshots.delete(client.sessionId);
        client.send('removed');
        client.leave(CLOSE_REMOVED);
      }
      pushFeed(this.world, `${player.name} left the game.`);
      this.release(id);
      this.persist();
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
      return { world: this.world, identities: this.identities, sessions: this.sessions };
    }

    onRestoreRoom(cache?: Cache<W>) {
      if (!cache) return;
      this.identities = cache.identities ?? {};
      this.sessions = cache.sessions ?? {};
      this.playerInputs = {}; this.inputAt = {}; this.snapshots.clear();
      try {
        this.world = this.load(cache.world);
        this.frozen = null;
        clearError();
        pushFeed(this.world, `♻ New game code loaded (${runtime().loaded.slice(0, 8)}).`);
      } catch (error) {
        // Keep the real state visible and untouched; the previous code can still read it.
        this.world = cache.world;
        this.freeze(error);
      }
      for (const player of Object.values(this.world.players)) player.online = false;
      this.prepare();
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
