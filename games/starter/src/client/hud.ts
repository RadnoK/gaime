import type { CatalogEntry } from '@gaime/core';
import type { ConnectionState } from '@gaime/core/client';
import type { Player, World } from '../shared/types';

export interface HudActions {
  join(name: string): void;
  start(): void;
  restart(): void;
  togglePause(): void;
  equip(slot: 0 | 1, ability: string): void;
  chat(text: string): void;
  leave(): void;
  ranking(): void;
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** DOM overlay: lobby, status bar, feed + chat, abilities, roster, banners and toasts. */
export class Hud {
  readonly root: HTMLElement;
  private readonly abort = new AbortController();
  private readonly cache = new Map<string, string>();
  private toastTimer?: ReturnType<typeof setTimeout>;
  private world?: World;
  private meId = '';

  constructor(parent: HTMLElement, private readonly actions: HudActions) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="top">
        <div class="wave"><b id="wave">—</b><span id="phase"></span></div>
        <div class="crystal"><span>CRYSTAL</span><div class="meter"><i id="crystal-bar"></i></div><b id="crystal-hp"></b></div>
        <div class="score"><span>SCORE</span><b id="score">0</b></div>
        <div class="conn"><span id="status" class="pill">…</span><span id="ping" class="micro"></span><button id="menu" title="Menu">☰</button></div>
      </div>
      <aside class="roster" id="roster"></aside>
      <div class="banner" id="banner" hidden></div>
      <div class="bottom">
        <div class="left">
          <ol class="feed" id="feed"></ol>
          <form class="chat" id="chat" autocomplete="off"><input id="chat-input" maxlength="200" placeholder="Enter — chat" /></form>
        </div>
        <div class="center">
          <div class="vitals"><div class="meter hp"><i id="hp-bar"></i></div><b id="hp"></b></div>
          <div class="abilities" id="abilities"></div>
        </div>
        <div class="right micro">WASD move · mouse aim/shoot · Q/E abilities · Tab arsenal · Enter chat (/help) · M sound · F3 network</div>
      </div>
      <dialog class="panel" id="arsenal"><h2>Arsenal</h2><p class="micro">Abilities from every module in <code>src/features/*</code>. Click Q or E to bind.</p><div id="arsenal-list"></div><button class="close" data-close>Close</button></dialog>
      <dialog class="panel" id="menu-panel"><h2>Menu</h2><div class="stack"><button id="ranking">Ranking</button><button id="pause">Pause / resume (host)</button><button id="leave">Leave to lobby</button><button data-close>Back to the game</button></div></dialog>
      <div class="toast" id="toast" hidden></div>
      <pre class="netstats" id="netstats" hidden></pre>
      <div class="lobby" id="lobby" hidden>
        <form class="card" id="join-form">
          <h1>Crystal</h1>
          <p>Defend the crystal against waves of monsters. Anyone can add new enemies, abilities and attacks in <code>src/features/</code> — the game updates live.</p>
          <input id="name" maxlength="24" placeholder="Your nickname" required autofocus />
          <button type="submit">Join</button>
          <p class="micro" id="lobby-status"></p>
        </form>
      </div>`;
    parent.appendChild(this.root);
    const signal = this.abort.signal;

    this.el<HTMLFormElement>('join-form').addEventListener('submit', event => {
      event.preventDefault();
      const name = this.el<HTMLInputElement>('name').value.trim();
      if (name) actions.join(name);
    }, { signal });
    this.el<HTMLFormElement>('chat').addEventListener('submit', event => {
      event.preventDefault();
      const input = this.el<HTMLInputElement>('chat-input');
      if (input.value.trim()) actions.chat(input.value);
      input.value = '';
      input.blur();
    }, { signal });
    this.el('menu').addEventListener('click', () => this.el<HTMLDialogElement>('menu-panel').showModal(), { signal });
    this.el('ranking').addEventListener('click', () => { this.el<HTMLDialogElement>('menu-panel').close(); actions.ranking(); }, { signal });
    this.el('pause').addEventListener('click', () => { actions.togglePause(); this.el<HTMLDialogElement>('menu-panel').close(); }, { signal });
    this.el('leave').addEventListener('click', () => { this.el<HTMLDialogElement>('menu-panel').close(); actions.leave(); }, { signal });
    this.root.addEventListener('click', event => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-close]')) (target.closest('dialog') as HTMLDialogElement | null)?.close();
      const equip = target.closest<HTMLElement>('[data-equip]');
      if (equip) actions.equip(Number(equip.dataset.slot) as 0 | 1, equip.dataset.equip!);
      const banner = target.closest<HTMLElement>('[data-action]');
      if (banner?.dataset.action === 'start') actions.start();
      if (banner?.dataset.action === 'restart') actions.restart();
    }, { signal });
  }

  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.root.querySelector<T>(`#${id}`)!;
  }

  /** Writes innerHTML only when it changed (keeps DOM work tiny at 15 Hz). */
  private html(id: string, html: string) {
    if (this.cache.get(id) === html) return;
    this.cache.set(id, html);
    this.el(id).innerHTML = html;
  }

  private text(id: string, text: string) {
    if (this.cache.get(id) === text) return;
    this.cache.set(id, text);
    this.el(id).textContent = text;
  }

  get typing() { return document.activeElement?.id === 'chat-input'; }
  focusChat() { this.el<HTMLInputElement>('chat-input').focus(); }

  toggleNetStats() {
    const panel = this.el('netstats');
    panel.hidden = !panel.hidden;
    return !panel.hidden;
  }

  netStats(text: string) { this.text('netstats', text); }

  toggleArsenal() {
    const dialog = this.el<HTMLDialogElement>('arsenal');
    if (dialog.open) dialog.close(); else dialog.showModal();
  }

  showLobby(name: string, status = '') {
    this.el('lobby').hidden = false;
    const input = this.el<HTMLInputElement>('name');
    if (!input.value) input.value = name;
    this.text('lobby-status', status);
    input.focus();
  }

  hideLobby() { this.el('lobby').hidden = true; }

  status(state: ConnectionState, text: string) {
    const pill = this.el('status');
    pill.textContent = text;
    pill.dataset.state = state;
    if (!this.el('lobby').hidden) this.text('lobby-status', state === 'connected' ? '' : text);
  }

  notice(text: string) {
    const toast = this.el('toast');
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { toast.hidden = true; }, Math.min(12000, 3000 + text.length * 40));
  }

  render(world: World, meId: string, ping?: number) {
    this.world = world;
    this.meId = meId;
    const me = world.players[meId] as Player | undefined;
    const phase = { lobby: 'waiting for the start', fight: world.waveName, break: `break ${Math.max(0, Math.ceil(world.nextWaveAt - world.time))} s`, lost: 'crystal destroyed' }[world.phase];
    this.text('wave', world.wave ? `WAVE ${world.wave}` : 'LOBBY');
    this.text('phase', phase);
    this.text('score', String(world.score));
    this.text('crystal-hp', `${Math.ceil(world.crystal.hp)} / ${world.crystal.maxHp}`);
    this.el('crystal-bar').style.width = `${(100 * world.crystal.hp) / world.crystal.maxHp}%`;
    this.text('ping', ping === undefined ? '' : `${Math.round(ping)} ms`);

    const players = Object.values(world.players).sort((a, b) => Number(b.online) - Number(a.online) || b.kills - a.kills);
    this.html('roster', players.map(p => `<div class="${p.online ? '' : 'off'}${p.id === meId ? ' me' : ''}"><i style="background:${p.color}"></i>${world.hostId === p.id ? '👑 ' : ''}${escape(p.name)}<b>${p.kills}</b></div>`).join(''));

    this.html('feed', world.feed.slice(-8).map(item => {
      const from = item.from ? world.players[item.from] : undefined;
      if (from && item.kind === 'me') return `<li class="me" style="color:${from.color}">* ${escape(from.name)} ${escape(item.text)}</li>`;
      return from ? `<li><b style="color:${from.color}">${escape(from.name)}:</b> ${escape(item.text)}</li>` : `<li class="system">${escape(item.text)}</li>`;
    }).join(''));

    if (me) {
      this.text('hp', me.respawnAt ? '✝' : String(Math.ceil(me.hp)));
      this.el('hp-bar').style.width = `${(100 * me.hp) / me.maxHp}%`;
      const abilities = me.abilities.map((id, slot) => {
        const def = world.catalog.find(e => e.kind === 'abilities' && e.id === id);
        const left = Math.max(0, (me.cooldowns[id] ?? 0) - world.time);
        const cooldown = Number(def?.cooldown ?? 1) || 1;
        return `<div class="ability" style="--c:${def?.color ?? '#888'}" title="${escape(def ? `${def.name} — ${def.description} (by ${def.author})` : 'empty slot')}"><kbd>${slot ? 'E' : 'Q'}</kbd><span>${escape(String(def?.icon ?? '?'))}</span><small>${escape(def?.name ?? '—')}</small>${left > 0 ? `<em style="height:${(100 * left) / cooldown}%"></em><b>${left.toFixed(1)}</b>` : ''}</div>`;
      });
      this.html('abilities', abilities.join(''));
      this.html('arsenal-list', this.arsenal(world.catalog, me));
    }

    const banner = this.banner(world, me);
    this.el('banner').hidden = !banner;
    this.html('banner', banner);
  }

  private arsenal(catalog: CatalogEntry[], me: Player) {
    return catalog.filter(entry => entry.kind === 'abilities').map(entry => `
      <div class="entry" style="--c:${entry.color}">
        <span class="icon">${escape(String(entry.icon ?? '?'))}</span>
        <div><b>${escape(entry.name)}</b> <small>${escape(entry.author)} · ${entry.cooldown}s</small><p>${escape(entry.description)}</p></div>
        <button data-equip="${entry.id}" data-slot="0" class="${me.abilities[0] === entry.id ? 'on' : ''}">Q</button>
        <button data-equip="${entry.id}" data-slot="1" class="${me.abilities[1] === entry.id ? 'on' : ''}">E</button>
      </div>`).join('');
  }

  private banner(world: World, me?: Player) {
    if (world.pause?.reason === 'error') return `<h2>⚠ Game paused — code error</h2><p>${escape(world.pause.message ?? '')}</p><p class="micro">Fix the code and push a commit — the hot reload resumes the game automatically.</p>`;
    if (world.pause) return `<h2>Paused</h2><p class="micro">The host can resume the game from the ☰ menu.</p>`;
    if (world.phase === 'lost') return `<h2>Crystal destroyed</h2><p>Wave ${world.wave} · score ${world.score}</p><button data-action="restart">New round</button>`;
    if (world.phase === 'lobby') {
      return world.hostId === this.meId
        ? `<h2>Ready?</h2><p class="micro">You are the host 👑</p><button data-action="start">Start (Enter)</button>`
        : `<h2>Waiting for the start</h2><p class="micro">The host 👑 starts the round</p>`;
    }
    if (me?.respawnAt) return `<h2>You are down</h2><p>Back in ${Math.max(0, Math.ceil(me.respawnAt - world.time))} s</p>`;
    return '';
  }

  /** Start/restart from the keyboard when the banner offers it. */
  primaryAction() {
    const world = this.world;
    if (!world || world.pause) return;
    if (world.phase === 'lobby' && world.hostId === this.meId) this.actions.start();
    else if (world.phase === 'lost') this.actions.restart();
  }

  dispose() {
    clearTimeout(this.toastTimer);
    this.abort.abort();
    this.root.remove();
  }
}
