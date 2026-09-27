import { Client, type Room } from '@colyseus/sdk';
import type { BaseWorld, Welcome } from '../shared/types';
import { CLOSE_REMOVED, CLOSE_REPLACED } from '../shared/types';
import type { EngineCommand, EventMessage, ResponseMessage } from '../shared/protocol';
import { applyWorldPatch, InputGate, type WorldPatch, type WorldSnapshot } from '../shared/net';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'full' | 'replaced' | 'removed' | 'error';

type Events<W> = {
  world: (world: W, previous: W | undefined) => void;
  status: (state: ConnectionState, text: string) => void;
  notice: (text: string) => void;
  welcome: (welcome: Welcome) => void;
  /** One-off server events (`ctx.emit(name, data)`). */
  event: (name: string, data: unknown) => void;
};

export interface GameClientOptions {
  /** Same as `GameDefinition.name`. */
  game: string;
  /** Server origin. Default: the page origin (Vite dev and production share one port). */
  url?: string;
  /**
   * `browser` (default): one character per browser profile (localStorage).
   * `tab`: every tab is a separate player — handy for local tests.
   * Either way `?player=<name>` in the URL selects an additional local identity.
   */
  identity?: 'browser' | 'tab';
  /**
   * Simulated bad network, for testing prediction and interpolation.
   * Defaults come from the URL: `?lag=150&jitter=40&loss=5` (round trip ms, ± ms, % of dropped inputs).
   */
  simulate?: { lag?: number; jitter?: number; loss?: number };
}

export interface NetStats {
  /** Measured round trip (plus simulated lag). */
  ping?: number;
  patchesPerSecond: number;
  /** Approximate downstream payload (JSON size of patches), bytes per second. */
  bytesPerSecond: number;
  inputsPerSecond: number;
  /** Full snapshots requested after a lost or out-of-order patch. */
  resyncs: number;
  simulated?: { lag: number; jitter: number; loss: number };
}

const TEXT: Record<ConnectionState, string> = {
  idle: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  full: 'The game is full.',
  replaced: 'The game was opened in another tab.',
  removed: 'You were removed from the game.',
  error: 'Connection error.',
};

function makeTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Connection to the game's single shared room: identity, automatic reconnection
 * (network drops, server hot reloads and restarts), delta patches, throttled input,
 * RPC requests, server events and optional network simulation.
 */
export class GameClient<W extends BaseWorld = BaseWorld, I = unknown, C extends { type: string } = { type: string }> {
  id = '';
  world?: W;
  state: ConnectionState = 'idle';
  /** Round trip in ms (including simulated lag), refreshed every 2 s. */
  ping?: number;

  private readonly listeners: { [K in keyof Events<W>]: Set<Events<W>[K]> } = { world: new Set(), status: new Set(), notice: new Set(), welcome: new Set(), event: new Set() };
  private readonly sdk: Client;
  private readonly storageKey: string;
  private readonly store: Storage;
  private readonly simulate: { lag: number; jitter: number; loss: number };
  private room?: Room;
  private snapshot?: WorldSnapshot<W>;
  private resyncing = false;
  private stopped = true;
  private joining = false;
  private name = '';
  private retry?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly gate = new InputGate<I>();
  private requestSeq = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sendAt = 0;
  private receiveAt = 0;
  private readonly counters = { patches: [] as number[], bytes: [] as Array<[number, number]>, inputs: [] as number[], resyncs: 0 };

  constructor(options: GameClientOptions) {
    this.sdk = new Client(options.url ?? location.origin);
    const params = new URLSearchParams(location.search);
    const local = params.get('player')?.replace(/[^\w-]/g, '').slice(0, 24);
    this.storageKey = `gaime:${options.game}${local ? `:${local}` : ''}`;
    this.store = options.identity === 'tab' ? sessionStorage : localStorage;
    const number = (name: string) => Math.max(0, Number(params.get(name)) || 0);
    this.simulate = {
      lag: options.simulate?.lag ?? number('lag'),
      jitter: options.simulate?.jitter ?? number('jitter'),
      loss: Math.min(100, options.simulate?.loss ?? number('loss')),
    };
    if (this.simulated) console.info('[gaime] simulated network', this.simulate);
  }

  private get simulated() { return this.simulate.lag > 0 || this.simulate.jitter > 0 || this.simulate.loss > 0; }

  on<K extends keyof Events<W>>(event: K, listener: Events<W>[K]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  /** Detach every listener (used when a hot-reloaded module takes over this connection). */
  off() { for (const set of Object.values(this.listeners)) set.clear(); }

  get connected() { return this.state === 'connected'; }
  get ticket() {
    let ticket = this.store.getItem(`${this.storageKey}:ticket`);
    if (!ticket) { ticket = makeTicket(); this.store.setItem(`${this.storageKey}:ticket`, ticket); }
    return ticket;
  }
  /** Name used for the last join in this tab; lets a reloaded page rejoin without the lobby. */
  get savedName() { return sessionStorage.getItem(`${this.storageKey}:active`) ?? ''; }
  get lastName() { return localStorage.getItem(`${this.storageKey}:name`) ?? ''; }

  get stats(): NetStats {
    const now = performance.now();
    const recent = (list: number[]) => list.filter(at => now - at < 1000).length;
    return {
      ping: this.ping,
      patchesPerSecond: recent(this.counters.patches),
      bytesPerSecond: this.counters.bytes.filter(([at]) => now - at < 1000).reduce((sum, [, bytes]) => sum + bytes, 0),
      inputsPerSecond: recent(this.counters.inputs),
      resyncs: this.counters.resyncs,
      ...(this.simulated ? { simulated: { ...this.simulate } } : {}),
    };
  }

  private count(list: number[] | Array<[number, number]>, value?: number) {
    const now = performance.now();
    (list as unknown[]).push(value === undefined ? now : [now, value]);
    while (list.length > 400) list.shift();
  }

  async join(name: string) {
    this.name = name.trim().slice(0, 24);
    this.stopped = false;
    localStorage.setItem(`${this.storageKey}:name`, this.name);
    sessionStorage.setItem(`${this.storageKey}:active`, this.name);
    await this.connect();
  }

  private async connect() {
    if (this.joining || this.stopped) return;
    this.joining = true;
    clearTimeout(this.retry);
    this.setState(this.room ? 'reconnecting' : 'connecting');
    try {
      let room: Room | undefined;
      const token = sessionStorage.getItem(`${this.storageKey}:reconnect`);
      if (token) {
        try { room = await this.sdk.reconnect(token); }
        catch { sessionStorage.removeItem(`${this.storageKey}:reconnect`); }
      }
      if (!room) {
        const response = await fetch('/gaime/room', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Game server unavailable (${response.status}).`);
        const { roomId } = await response.json() as { roomId: string };
        room = await this.sdk.joinById(roomId, { name: this.name, ticket: this.ticket });
      }
      if (this.stopped) { room.reconnection.enabled = false; void room.leave(true).catch(() => {}); return; }
      this.attach(room);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/full|403/i.test(text)) { this.setState('full', text); return; }
      this.setState('error', text);
      if (!this.stopped) this.retry = setTimeout(() => void this.connect(), 2000);
    } finally {
      this.joining = false;
    }
  }

  /** Simulated one-way delay; order is preserved like on a real TCP connection. */
  private delay(direction: 'sendAt' | 'receiveAt') {
    const base = this.simulate.lag / 2 + (Math.random() - 0.5) * this.simulate.jitter;
    const at = Math.max(performance.now() + Math.max(0, base), this[direction]);
    this[direction] = at;
    return at - performance.now();
  }

  private transmit(type: string, payload?: unknown) {
    const room = this.room;
    if (!room) return;
    if (!this.simulated) { room.send(type, payload); return; }
    if (type === 'input' && Math.random() * 100 < this.simulate.loss) return;
    setTimeout(() => { if (this.room === room && this.connected) room.send(type, payload); }, this.delay('sendAt'));
  }

  private listen<T>(room: Room, type: string, handler: (data: T) => void) {
    room.onMessage(type, (data: T) => {
      if (!this.simulated) { handler(data); return; }
      setTimeout(() => handler(data), this.delay('receiveAt'));
    });
  }

  private attach(room: Room) {
    this.room = room;
    const mine = () => this.room === room && !this.stopped;
    const remember = () => sessionStorage.setItem(`${this.storageKey}:reconnect`, room.reconnectionToken);
    remember();
    room.reconnection.minUptime = 0;
    room.reconnection.maxRetries = 8;
    room.reconnection.maxDelay = 1000;

    this.listen<Welcome & { world: W }>(room, 'welcome', data => {
      if (!mine()) return;
      remember();
      this.id = data.id;
      this.snapshot = { world: data.world, revision: data.revision };
      this.resyncing = false;
      this.gate.reset();
      for (const listener of this.listeners.welcome) listener(data);
      this.emitWorld(data.world);
    });
    this.listen<WorldPatch>(room, 'patch', patch => {
      if (!mine() || this.resyncing) return;
      const next = applyWorldPatch(this.snapshot, patch);
      if (!next) { this.resyncing = true; this.counters.resyncs++; this.transmit('hello'); return; }
      this.count(this.counters.patches);
      this.count(this.counters.bytes, JSON.stringify(patch).length);
      this.snapshot = next;
      this.emitWorld(next.world);
    });
    this.listen<EventMessage>(room, 'event', message => {
      if (mine()) for (const listener of this.listeners.event) listener(message.name, message.data);
    });
    this.listen<ResponseMessage>(room, 'response', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error ?? 'Request failed.'));
    });
    this.listen<string>(room, 'notice', text => { if (mine()) for (const listener of this.listeners.notice) listener(text); });
    room.onMessage('removed', () => { if (mine()) this.finish('removed'); });
    room.onDrop(() => {
      if (!mine()) return;
      this.snapshot = undefined; this.resyncing = true; this.ping = undefined;
      this.rejectPending('Connection lost.');
      this.setState('reconnecting');
    });
    room.onReconnect(() => {
      if (!mine()) return;
      remember();
      this.setState('connected');
      this.transmit('hello');
    });
    room.onLeave(code => {
      if (!mine()) return;
      this.rejectPending('Connection closed.');
      if (code === CLOSE_REMOVED) { this.finish('removed'); return; }
      if (code === CLOSE_REPLACED) { this.finish('replaced'); return; }
      // Reconnection gave up (server restart, long outage): join again with the same identity.
      this.setState('reconnecting');
      sessionStorage.removeItem(`${this.storageKey}:reconnect`);
      this.retry = setTimeout(() => void this.connect(), 1000);
    });
    room.onError((_code, text) => { if (mine() && text) for (const listener of this.listeners.notice) listener(text); });

    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.connected && this.room === room) room.ping(ms => { this.ping = ms + (this.simulated ? this.simulate.lag : 0); });
    }, 2000);
    this.setState('connected');
  }

  private rejectPending(reason: string) {
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error(reason)); this.pending.delete(id); }
  }

  private finish(state: ConnectionState) {
    this.stopped = true;
    sessionStorage.removeItem(`${this.storageKey}:reconnect`);
    sessionStorage.removeItem(`${this.storageKey}:active`);
    if (this.room) this.room.reconnection.enabled = false;
    this.setState(state);
  }

  private emitWorld(world: W) {
    const previous = this.world;
    this.world = world;
    for (const listener of this.listeners.world) listener(world, previous);
  }

  private setState(state: ConnectionState, text = TEXT[state]) {
    this.state = state;
    for (const listener of this.listeners.status) listener(state, text);
  }

  /** Continuous input (movement, aim). Throttled; repeated while unchanged so the server keeps it. */
  input(input: I) {
    if (!this.connected || !this.room) return;
    const next = this.gate.next(input, performance.now());
    if (next === undefined) return;
    this.count(this.counters.inputs);
    this.transmit('input', next);
  }

  /** Discrete action. Returns false when offline. */
  command(command: C | EngineCommand): boolean {
    if (!this.connected || !this.room) return false;
    this.transmit('command', command);
    return true;
  }

  chat(text: string) { return this.command({ type: '$chat', text }); }

  /** RPC to `GameDefinition.requests[name]`; resolves with its return value. */
  request<T = unknown>(name: string, payload?: unknown, timeout = 5000): Promise<T> {
    if (!this.connected || !this.room) return Promise.reject(new Error('Not connected.'));
    const id = ++this.requestSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Request "${name}" got no answer within ${timeout} ms.`)); }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.transmit('request', { id, name, payload });
    });
  }

  /** Leave on purpose: the character stays in the world (unless the game frees seats). */
  async leave() {
    this.stopped = true;
    clearTimeout(this.retry); clearInterval(this.pingTimer);
    this.rejectPending('Left the game.');
    sessionStorage.removeItem(`${this.storageKey}:active`);
    sessionStorage.removeItem(`${this.storageKey}:reconnect`);
    const room = this.room;
    this.room = undefined;
    if (room) {
      room.reconnection.enabled = false;
      await Promise.race([room.leave(true).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1200))]);
      room.connection.close();
    }
    this.setState('idle');
  }

  /** Drop the socket without leaving (page unload / full HMR teardown). */
  dispose() {
    this.stopped = true;
    clearTimeout(this.retry); clearInterval(this.pingTimer);
    this.rejectPending('Closed.');
    this.off();
    if (this.room) { this.room.reconnection.enabled = false; this.room.connection.close(); }
  }
}
