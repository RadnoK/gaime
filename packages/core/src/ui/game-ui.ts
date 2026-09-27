import type { GameClient } from '../client/client';
import type { BaseWorld } from '../shared/types';
import { Banner, ChatBox, Dialog, Lobby, Roster, StatusPill, Toasts, type RosterOptions } from './components';
import { h, Writer } from './dom';

export interface GameUiOptions<W extends BaseWorld> {
  client: GameClient<W, never, { type: string }> | GameClient<W, any, any>;
  /** Usually `document.getElementById('app')`. */
  parent: HTMLElement;
  title: string;
  /** Lobby text under the title. */
  description?: string;
  /** Controls hint in the bottom-right corner. */
  help?: string;
  roster?: RosterOptions<W> | false;
  /** Extra entries of the ☰ menu (pause/resume and leave are built in). */
  menu?: Array<{ label: string; action(): void }>;
  /** Actions for `data-action` buttons inside the banner. */
  actions?: Record<string, () => void>;
  /**
   * Enter was pressed outside an input: return true when the game used it
   * (e.g. "start round"), otherwise the chat gets focus.
   */
  onEnter?(): boolean;
  /** Join automatically after a page reload in this tab (default true). */
  autoJoin?: boolean;
  /** F3 network panel (default true). */
  netStats?: boolean;
}

/**
 * The standard multiplayer HUD, wired to a GameClient: lobby, connection status + ping,
 * ☰ menu (pause/resume for the host, leave), roster, feed + chat, toasts for notices,
 * a centred banner, F3 network stats. Your game adds its own widgets to `top`, `center`
 * (bottom middle) and `layer` (free overlay), and uses `dialog()` for panels.
 */
export class GameUi<W extends BaseWorld = BaseWorld> {
  readonly root: HTMLElement;
  /** Top bar, left side: your game's widgets (wave, score, timers…). */
  readonly top: HTMLElement;
  /** Bottom centre: health, abilities, hotbar… */
  readonly center: HTMLElement;
  /** Free overlay above the canvas (positioned elements). */
  readonly layer: HTMLElement;
  readonly lobby: Lobby;
  readonly toasts: Toasts;
  readonly chat: ChatBox<W>;
  readonly roster?: Roster<W>;
  readonly banner: Banner;
  readonly status: StatusPill;
  private readonly net: HTMLElement;
  private readonly menu: Dialog;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly abort = new AbortController();
  private readonly writer = new Writer();
  private netTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: GameUiOptions<W>) {
    const client = options.client as GameClient<W>;
    this.root = h('div', { class: 'g-hud' });
    this.top = h('div', { class: 'g-top-left' });
    const topRight = h('div', { class: 'g-top-right' });
    this.center = h('div', { class: 'g-center' });
    this.layer = h('div', { class: 'g-layer' });
    const left = h('div', { class: 'g-left' });
    const right = h('div', { class: 'g-right g-micro' }, options.help ?? '');
    this.root.append(h('div', { class: 'g-top' }, this.top, topRight), this.layer, h('div', { class: 'g-bottom' }, left, this.center, right));
    options.parent.append(this.root);

    this.status = new StatusPill(topRight);
    topRight.append(h('button', { class: 'g-button g-icon', title: 'Menu', onclick: () => this.menu.toggle() }, '☰'));
    this.roster = options.roster === false ? undefined : new Roster<W>(this.root, options.roster || {});
    this.chat = new ChatBox<W>(left, { send: text => client.chat(text), colorOf: options.roster ? options.roster.colorOf : undefined });
    this.banner = new Banner(this.root, options.actions);
    this.toasts = new Toasts(this.root);
    this.net = h('pre', { class: 'g-netstats', hidden: true });
    this.root.append(this.net);
    this.menu = new Dialog(this.root, { title: 'Menu' });
    const entries = [
      ...(options.menu ?? []),
      { label: 'Pause / resume (host)', action: () => client.command({ type: client.world?.pause ? '$resume' : '$pause' }) },
      { label: 'Leave to lobby', action: () => { void client.leave().then(() => this.lobby.show(client.lastName)); } },
    ];
    const stack = h('div', { class: 'g-stack' }, ...entries.map(entry => h('button', { class: 'g-button', onclick: () => { this.menu.close(); entry.action(); } }, entry.label)));
    this.menu.body.append(stack);
    this.lobby = new Lobby(this.root, { title: options.title, description: options.description, onJoin: name => { this.lobby.hide(); void client.join(name); } });

    this.unsubscribe.push(
      client.on('status', (state, text) => {
        this.status.set(state, text);
        if (this.lobby.visible) this.lobby.setStatus(state === 'connected' ? '' : text);
        if (state === 'full' || state === 'replaced' || state === 'removed') this.lobby.show(client.lastName, text);
      }),
      client.on('notice', text => this.toasts.show(text)),
      client.on('welcome', () => this.lobby.hide()),
      client.on('world', world => this.render(world)),
    );

    window.addEventListener('keydown', event => {
      if (event.defaultPrevented || this.chat.typing || this.lobby.visible || document.querySelector('dialog[open]')) return;
      if (event.code === 'Enter') { event.preventDefault(); if (!options.onEnter?.()) this.chat.focus(); }
      if (event.code === 'F3' && options.netStats !== false) { event.preventDefault(); this.toggleNetStats(); }
    }, { signal: this.abort.signal });

    if (client.world) { this.render(client.world); this.status.set(client.state, client.connected ? 'Connected' : '…'); }
    else if (options.autoJoin !== false && client.savedName) void client.join(client.savedName);
    else this.lobby.show(client.lastName);
  }

  /** Called on every world automatically; call it yourself after local changes if needed. */
  render(world: W) {
    const client = this.options.client as GameClient<W>;
    this.chat.render(world);
    this.roster?.render(world, client.id);
    this.status.setPing(client.ping);
  }

  /** True while the chat input has focus — ignore game keys then. */
  get typing() { return this.chat.typing; }

  /** A modal panel living in this HUD. */
  dialog(title: string, subtitle?: string) { return new Dialog(this.root, { title, subtitle }); }

  toggleNetStats() {
    this.net.hidden = !this.net.hidden;
    clearInterval(this.netTimer);
    if (this.net.hidden) return;
    const client = this.options.client as GameClient<W>;
    const poll = async () => {
      const s = client.stats;
      let server = '';
      try {
        const stats = await (await fetch('/gaime/stats', { cache: 'no-store' })).json();
        const workers = (stats.workers as Array<{ name: string; size: number; done: number; avgMs: number }>).map(w => `${w.name} ×${w.size} (${w.done} tasks, ${w.avgMs} ms)`).join(', ');
        server = `\nserver: tick ${stats.tickMs.avg}/${stats.tickMs.max} ms · publish ${stats.publishMs.avg} ms · patch ${stats.patchBytes.max} B\nevent loop p99 ${stats.eventLoopDelayMs.p99} ms · clients ${stats.clients} · RAM ${stats.memoryMb} MB${workers ? `\nworkers: ${workers}` : ''}`;
      } catch {}
      const simulated = s.simulated ? `\nsimulated: lag ${s.simulated.lag} ms ± ${s.simulated.jitter} · loss ${s.simulated.loss}%` : '';
      this.writer.text(this.net, `ping ${s.ping === undefined ? '—' : Math.round(s.ping)} ms · patches ${s.patchesPerSecond}/s · ~${(s.bytesPerSecond / 1024).toFixed(1)} KB/s\ninput ${s.inputsPerSecond}/s · resync ${s.resyncs}${simulated}${server}`);
    };
    void poll();
    this.netTimer = setInterval(() => void poll(), 500);
  }

  dispose() {
    for (const off of this.unsubscribe) off();
    this.abort.abort();
    clearInterval(this.netTimer);
    this.toasts.dispose();
    this.root.remove();
  }
}
