import type { CatalogEntry } from '@gaime/core';
import type { GameClient } from '@gaime/core/client';
import { escapeHtml, GameUi, h, meter, Writer, type Dialog } from '@gaime/core/ui';
import type { Command, Input, Player, World } from '../shared/types';

export interface HudActions {
  start(): void;
  restart(): void;
  equip(slot: 0 | 1, ability: string): void;
  ranking(): void;
}

/**
 * Crystal's HUD. The generic multiplayer parts (lobby, chat, roster, status, menu,
 * toasts, F3 stats) come from GameUi; this class only adds what is specific to the game.
 */
export class Hud {
  readonly ui: GameUi<World>;
  private readonly writer = new Writer();
  private readonly wave = h('b');
  private readonly phase = h('span', { class: 'g-micro' });
  private readonly crystal = meter();
  private readonly crystalHp = h('b');
  private readonly score = h('b');
  private readonly health = meter('var(--g-ok)');
  private readonly healthText = h('b');
  private readonly abilities = h('div', { class: 'abilities' });
  private readonly arsenal: Dialog;
  private world?: World;

  constructor(parent: HTMLElement, private readonly net: GameClient<World, Input, Command>, private readonly actions: HudActions) {
    this.ui = new GameUi<World>({
      client: net, parent,
      title: 'Crystal',
      description: 'Defend the crystal against waves of monsters. Anyone can add new enemies, abilities and attacks in src/features/ — the game updates live.',
      help: 'WASD move · mouse aim/shoot · Q/E abilities · Tab arsenal · Enter chat (/help, /bot) · M sound · F3 network',
      roster: { detail: player => String((player as Player).kills) },
      menu: [{ label: 'Ranking', action: () => actions.ranking() }],
      actions: { start: () => actions.start(), restart: () => actions.restart() },
      onEnter: () => this.primaryAction(),
    });
    this.ui.top.append(
      h('div', { class: 'wave' }, this.wave, this.phase),
      h('div', { class: 'crystal' }, h('span', { class: 'g-micro' }, 'CRYSTAL'), this.crystal.element, this.crystalHp),
      h('div', {}, h('span', { class: 'g-micro' }, 'SCORE '), this.score),
    );
    this.ui.center.append(h('div', { class: 'vitals' }, this.health.element, this.healthText), this.abilities);
    this.arsenal = this.ui.dialog('Arsenal', 'Abilities from every module in src/features/*. Click Q or E to bind.');
    this.arsenal.body.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-equip]');
      if (button) actions.equip(Number(button.dataset.slot) as 0 | 1, button.dataset.equip!);
    });
  }

  get typing() { return this.ui.typing; }
  notice(text: string) { this.ui.toasts.show(text); }
  toggleArsenal() { this.arsenal.toggle(); }

  render(world: World) {
    this.world = world;
    const me = world.players[this.net.id] as Player | undefined;
    this.writer.text(this.wave, world.wave ? `WAVE ${world.wave} ` : 'LOBBY ');
    this.writer.text(this.phase, { lobby: 'waiting for the start', fight: world.waveName, break: `break ${Math.max(0, Math.ceil(world.nextWaveAt - world.time))} s`, lost: 'crystal destroyed' }[world.phase]);
    this.crystal.set(world.crystal.hp / world.crystal.maxHp);
    this.writer.text(this.crystalHp, `${Math.ceil(world.crystal.hp)} / ${world.crystal.maxHp}`);
    this.writer.text(this.score, String(world.score));

    if (me) {
      this.health.set(me.hp / me.maxHp);
      this.writer.text(this.healthText, me.respawnAt ? '✝' : String(Math.ceil(me.hp)));
      this.writer.html(this.abilities, me.abilities.map((id, slot) => {
        const def = world.catalog.find(entry => entry.kind === 'abilities' && entry.id === id);
        const left = Math.max(0, (me.cooldowns[id] ?? 0) - world.time);
        const cooldown = Number(def?.cooldown ?? 1) || 1;
        const title = def ? `${def.name} — ${def.description} (by ${def.author})` : 'empty slot';
        return `<div class="ability" style="--c:${escapeHtml(def?.color ?? '#888')}" title="${escapeHtml(title)}"><kbd>${slot ? 'E' : 'Q'}</kbd><span>${escapeHtml(String(def?.icon ?? '?'))}</span><small>${escapeHtml(def?.name ?? '—')}</small>${left > 0 ? `<em style="height:${(100 * left) / cooldown}%"></em><b>${left.toFixed(1)}</b>` : ''}</div>`;
      }).join(''));
      this.arsenal.setContent(this.arsenalHtml(world.catalog, me));
    }
    this.ui.banner.set(this.banner(world, me));
  }

  private arsenalHtml(catalog: CatalogEntry[], me: Player) {
    return catalog.filter(entry => entry.kind === 'abilities').map(entry => `
      <div class="entry" style="--c:${escapeHtml(entry.color)}">
        <span class="icon">${escapeHtml(entry.icon ?? '?')}</span>
        <div><b>${escapeHtml(entry.name)}</b> <small>${escapeHtml(entry.author)} · ${escapeHtml(entry.cooldown)}s</small><p>${escapeHtml(entry.description)}</p></div>
        <button class="g-button${me.abilities[0] === entry.id ? ' on' : ''}" data-equip="${escapeHtml(entry.id)}" data-slot="0">Q</button>
        <button class="g-button${me.abilities[1] === entry.id ? ' on' : ''}" data-equip="${escapeHtml(entry.id)}" data-slot="1">E</button>
      </div>`).join('');
  }

  private banner(world: World, me?: Player): string | null {
    if (world.pause?.reason === 'error') return `<h2>⚠ Game paused — code error</h2><p>${escapeHtml(world.pause.message ?? '')}</p><p class="g-micro">Fix the code and push a commit — the hot reload resumes the game automatically.</p>`;
    if (world.pause) return `<h2>Paused</h2><p class="g-micro">The host can resume the game from the ☰ menu.</p>`;
    if (world.phase === 'lost') return `<h2>Crystal destroyed</h2><p>Wave ${world.wave} · score ${world.score}</p><button data-action="restart">New round</button>`;
    if (world.phase === 'lobby') {
      return world.hostId === this.net.id
        ? `<h2>Ready?</h2><p class="g-micro">You are the host 👑 — type /bot in chat to add bot teammates</p><button data-action="start">Start (Enter)</button>`
        : `<h2>Waiting for the start</h2><p class="g-micro">The host 👑 starts the round</p>`;
    }
    if (me?.respawnAt) return `<h2>You are down</h2><p>Back in ${Math.max(0, Math.ceil(me.respawnAt - world.time))} s</p>`;
    return null;
  }

  /** Enter: start/restart when the banner offers it (returns false to let Enter open the chat). */
  private primaryAction() {
    const world = this.world;
    if (!world || world.pause) return false;
    if (world.phase === 'lobby' && world.hostId === this.net.id) { this.actions.start(); return true; }
    if (world.phase === 'lost') { this.actions.restart(); return true; }
    return false;
  }

  dispose() { this.ui.dispose(); }
}
