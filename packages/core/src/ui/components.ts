import type { BasePlayer, BaseWorld } from '../shared/types';
import { escapeHtml, h, Writer } from './dom';

/** Name form shown before joining and whenever the connection ends for good. */
export class Lobby {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;

  constructor(parent: HTMLElement, options: { title: string; description?: string; button?: string; placeholder?: string; onJoin(name: string): void }) {
    this.input = h('input', { class: 'g-input', maxlength: 24, placeholder: options.placeholder ?? 'Your nickname', required: true, autocomplete: 'nickname' });
    this.status = h('p', { class: 'g-micro' });
    const form = h('form', { class: 'g-card' },
      h('h1', {}, options.title),
      options.description ? h('p', {}, options.description) : null,
      this.input,
      h('button', { class: 'g-button g-primary', type: 'submit' }, options.button ?? 'Join'),
      this.status,
    );
    form.addEventListener('submit', event => {
      event.preventDefault();
      const name = this.input.value.trim();
      if (name) options.onJoin(name);
    });
    this.element = h('div', { class: 'g-lobby', hidden: true }, form);
    parent.append(this.element);
  }

  get visible() { return !this.element.hidden; }

  show(name = '', status = '') {
    this.element.hidden = false;
    if (!this.input.value) this.input.value = name;
    this.status.textContent = status;
    this.input.focus();
  }

  setStatus(text: string) { this.status.textContent = text; }
  hide() { this.element.hidden = true; }
}

/** Transient messages (server notices, results). Multi-line text is kept. */
export class Toasts {
  readonly element: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(parent: HTMLElement) {
    this.element = h('div', { class: 'g-toast', hidden: true, role: 'status' });
    parent.append(this.element);
  }

  show(text: string, ms = Math.min(12_000, 3000 + text.length * 40)) {
    this.element.textContent = text;
    this.element.hidden = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.element.hidden = true; }, ms);
  }

  dispose() { clearTimeout(this.timer); }
}

export interface ChatBoxOptions<W extends BaseWorld> {
  send(text: string): void;
  /** Colour of a player's name. Default: `player.color` when present. */
  colorOf?(player: W['players'][string]): string | undefined;
  lines?: number;
  placeholder?: string;
}

/** World feed (system messages + chat) with an input line. Enter focuses it (see GameUi). */
export class ChatBox<W extends BaseWorld = BaseWorld> {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly writer = new Writer();

  constructor(parent: HTMLElement, private readonly options: ChatBoxOptions<W>) {
    this.list = h('ol', { class: 'g-feed' });
    this.input = h('input', { class: 'g-input g-chat-input', maxlength: 200, autocomplete: 'off', placeholder: options.placeholder ?? 'Enter — chat, /help — commands' });
    const form = h('form', { class: 'g-chat' }, this.input);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.input.value.trim()) options.send(this.input.value);
      this.input.value = '';
      this.input.blur();
    });
    this.input.addEventListener('keydown', event => { if (event.key === 'Escape') this.input.blur(); });
    this.element = h('div', { class: 'g-chatbox' }, this.list, form);
    parent.append(this.element);
  }

  get typing() { return document.activeElement === this.input; }
  focus() { this.input.focus(); }

  render(world: W) {
    const colorOf: (player: BasePlayer) => string | undefined = (this.options.colorOf as ((player: BasePlayer) => string | undefined) | undefined) ?? (player => (player as BasePlayer & { color?: string }).color);
    this.writer.html(this.list, world.feed.slice(-(this.options.lines ?? 8)).map(item => {
      const from = item.from ? world.players[item.from] : undefined;
      const color = from ? colorOf(from) ?? 'var(--g-accent)' : '';
      if (from && item.kind === 'me') return `<li class="g-me" style="color:${escapeHtml(color)}">* ${escapeHtml(from.name)} ${escapeHtml(item.text)}</li>`;
      if (from) return `<li><b style="color:${escapeHtml(color)}">${escapeHtml(from.name)}:</b> ${escapeHtml(item.text)}</li>`;
      return `<li class="g-system">${escapeHtml(item.text)}</li>`;
    }).join(''));
  }
}

export interface RosterOptions<W extends BaseWorld> {
  /** Right-hand column (score, kills, ready ✓). */
  detail?(player: W['players'][string], world: W): string;
  colorOf?(player: W['players'][string]): string | undefined;
  /** Sort order; default online first, then by name. */
  sort?(a: W['players'][string], b: W['players'][string]): number;
  /** Hide offline players. Default false. */
  onlineOnly?: boolean;
}

/** Player list: colour, host crown 👑, bot 🤖, offline dimmed, you highlighted. */
export class Roster<W extends BaseWorld = BaseWorld> {
  readonly element: HTMLElement;
  private readonly writer = new Writer();

  constructor(parent: HTMLElement, private readonly options: RosterOptions<W> = {}) {
    this.element = h('aside', { class: 'g-roster' });
    parent.append(this.element);
  }

  render(world: W, meId: string) {
    const colorOf: (player: BasePlayer) => string | undefined = (this.options.colorOf as ((player: BasePlayer) => string | undefined) | undefined) ?? (player => (player as BasePlayer & { color?: string }).color);
    let players = Object.values(world.players) as Array<W['players'][string]>;
    if (this.options.onlineOnly) players = players.filter(p => p.online);
    players.sort(this.options.sort ?? ((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)));
    this.writer.html(this.element, players.map(player => {
      const badge = `${world.hostId === player.id ? '👑 ' : ''}${player.data['gaime-bot'] ? '🤖 ' : ''}`;
      const detail = this.options.detail?.(player, world) ?? '';
      return `<div class="${player.online ? '' : 'g-off'}${player.id === meId ? ' g-self' : ''}"><i style="background:${escapeHtml(colorOf(player) ?? 'var(--g-muted)')}"></i>${badge}${escapeHtml(player.name)}<b>${escapeHtml(detail)}</b></div>`;
    }).join(''));
  }
}

/**
 * Centred message box. HTML content; elements with `data-action="name"` call
 * `actions[name]()` when clicked.
 */
export class Banner {
  readonly element: HTMLElement;
  private readonly writer = new Writer();

  constructor(parent: HTMLElement, private readonly actions: Record<string, () => void> = {}) {
    this.element = h('div', { class: 'g-banner', hidden: true });
    this.element.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (target?.dataset.action) this.actions[target.dataset.action]?.();
    });
    parent.append(this.element);
  }

  on(action: string, handler: () => void) { this.actions[action] = handler; }

  /** `null`/empty hides the banner. */
  set(html: string | null) {
    this.element.hidden = !html;
    if (html) this.writer.html(this.element, html);
  }
}

/** Modal panel (arsenal, inventory, settings). `setContent` accepts HTML. */
export class Dialog {
  readonly element: HTMLDialogElement;
  readonly body: HTMLElement;
  private readonly writer = new Writer();

  constructor(parent: HTMLElement, options: { title: string; subtitle?: string }) {
    this.body = h('div', { class: 'g-dialog-body' });
    this.element = h('dialog', { class: 'g-dialog' },
      h('h2', {}, options.title),
      options.subtitle ? h('p', { class: 'g-micro' }, options.subtitle) : null,
      this.body,
      h('button', { class: 'g-button', onclick: () => this.close() }, 'Close'),
    );
    parent.append(this.element);
  }

  get open() { return this.element.open; }
  setContent(html: string) { this.writer.html(this.body, html); }
  show() { if (!this.element.open) this.element.showModal(); }
  close() { this.element.close(); }
  toggle() { if (this.element.open) this.close(); else this.show(); }
}

/** Connection state + ping. */
export class StatusPill {
  readonly element: HTMLElement;
  private readonly label: HTMLElement;
  private readonly ping: HTMLElement;

  constructor(parent: HTMLElement) {
    this.label = h('span', { class: 'g-pill' }, '…');
    this.ping = h('span', { class: 'g-micro' });
    this.element = h('div', { class: 'g-status' }, this.label, this.ping);
    parent.append(this.element);
  }

  set(state: string, text: string) { this.label.textContent = text; this.label.dataset.state = state; }
  setPing(ms?: number) { this.ping.textContent = ms === undefined ? '' : `${Math.round(ms)} ms`; }
}
