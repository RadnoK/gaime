import type { GameClient } from '@gaime/core/client';
import { matchTimeLeft, turnTimeLeft } from '@gaime/core/kit';
import { escapeHtml, GameUi, h, meter, Writer } from '@gaime/core/ui';
import type { Command, Input, Player, World } from '../shared/types';
import { RULES } from '../shared/rules';
import { activeId, fightersOf } from './util';

/** Duel HUD on top of GameUi: turn + timer, wind, score, power meter, weapon bar, banners. */
export class Hud {
  readonly ui: GameUi<World>;
  private readonly writer = new Writer();
  private readonly turn = h('b');
  private readonly clock = h('span', { class: 'g-micro' });
  private readonly wind = h('b');
  private readonly score = h('b');
  private readonly power = meter('var(--g-warn)');
  private readonly weapons = h('div', { class: 'weapons' });

  constructor(parent: HTMLElement, private readonly net: GameClient<World, Input, Command>) {
    this.ui = new GameUi<World>({
      client: net, parent,
      title: 'Duel',
      description: 'Turn-based artillery for two. Invite a friend with this page\'s address — or type /bot in the chat to play against the computer.',
      help: 'A/D move · W/S aim · hold Space to charge, release to fire · 1–9 weapons · Enter chat (/bot) · F3 network',
      roster: {
        detail: player => ((player as Player).seat >= 0 ? `${(player as Player).wins} ${(player as Player).seat === 0 ? '◀' : '▶'}` : 'watching'),
        colorOf: player => { const seat = (player as Player).seat; return seat === 0 || seat === 1 ? RULES.colors[seat] : undefined; },
      },
      actions: { ready: () => net.command({ type: 'ready' }) },
    });
    this.ui.top.append(
      h('div', { class: 'turn' }, this.turn, this.clock),
      h('div', {}, h('span', { class: 'g-micro' }, 'WIND '), this.wind),
      h('div', {}, h('span', { class: 'g-micro' }, 'SCORE '), this.score),
    );
    this.ui.center.append(h('div', { class: 'power' }, h('span', { class: 'g-micro' }, 'POWER'), this.power.element), this.weapons);
    this.weapons.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-weapon]');
      if (button) net.command({ type: 'weapon', id: button.dataset.weapon! });
    });
  }

  get typing() { return this.ui.typing; }

  setCharge(value: number) { this.power.set(value); }

  render(world: World) {
    const me = world.players[this.net.id];
    const [left, right] = fightersOf(world);
    const active = activeId(world);
    const turns = world.turns;
    if (world.match.phase === 'playing' && turns) {
      this.writer.text(this.turn, active === this.net.id ? 'YOUR TURN ' : `${world.players[active ?? '']?.name ?? '—'}'s turn `);
      this.writer.text(this.clock, world.shotFired ? (world.retreatUntil ? 'retreat!' : 'shot in flight') : `${Math.ceil(turnTimeLeft(turns, world.time))} s`);
    } else {
      this.writer.text(this.turn, world.match.phase.toUpperCase() + ' ');
      this.writer.text(this.clock, '');
    }
    const strength = Math.abs(world.wind);
    this.writer.text(this.wind, strength < 0.25 ? 'calm' : `${world.wind > 0 ? '→' : '←'} ${strength.toFixed(1)}`);
    this.writer.text(this.score, `${left?.wins ?? 0} : ${right?.wins ?? 0}`);

    if (me && me.seat >= 0) {
      this.writer.html(this.weapons, world.catalog.filter(entry => entry.kind === 'weapons' && !entry.hidden).map((entry, index) => {
        const limited = entry.ammo !== undefined;
        const left = limited ? me.ammo[entry.id] ?? Number(entry.ammo) : Infinity;
        return `<button class="g-button weapon${me.weapon === entry.id ? ' on' : ''}${left <= 0 ? ' empty' : ''}" data-weapon="${escapeHtml(entry.id)}" style="--c:${escapeHtml(entry.color)}" title="${escapeHtml(`${entry.name} — ${entry.description} (by ${entry.author})`)}"><kbd>${index + 1}</kbd>${escapeHtml(entry.icon)}<small>${limited ? left : '∞'}</small></button>`;
      }).join(''));
    } else this.writer.html(this.weapons, '');

    this.ui.banner.set(this.banner(world, me));
  }

  private banner(world: World, me?: Player): string | null {
    if (world.pause?.reason === 'error') return `<h2>⚠ Game paused — code error</h2><p>${escapeHtml(world.pause.message ?? '')}</p>`;
    if (world.pause) return '<h2>Paused</h2>';
    const seated = fightersOf(world);
    const spectator = !me || me.seat < 0;
    const ready = (p: Player) => (world.match.ready[p.id] ? '✓ ready' : '… not ready');
    if (world.match.phase === 'countdown') return `<h2>${Math.ceil(matchTimeLeft(world.match, world.time))}</h2><p>${seated.map(p => escapeHtml(p.name)).join(' vs ')}</p>`;
    if (world.match.phase === 'ended') {
      const winner = world.match.winner ? world.players[world.match.winner] : undefined;
      const title = !winner ? 'Draw!' : winner.id === this.net.id ? '🏆 You win!' : `${escapeHtml(winner.name)} wins`;
      return `<h2>${title}</h2><p class="g-micro">${seated.map(p => `${escapeHtml(p.name)} ${p.wins}`).join(' · ')}</p>${spectator ? '' : '<button data-action="ready">Rematch</button>'}`;
    }
    if (world.match.phase === 'lobby') {
      if (seated.length < 2) return `<h2>Waiting for an opponent</h2><p class="g-micro">Share this page's address, or type <b>/bot</b> in the chat (host) to play the computer.</p>`;
      const list = seated.map(p => `<p>${escapeHtml(p.name)} — ${ready(p)}</p>`).join('');
      if (spectator) return `<h2>Next duel</h2>${list}<p class="g-micro">Both seats are taken — you are watching.</p>`;
      return `<h2>Duel</h2>${list}<button data-action="ready">${world.match.ready[me!.id] ? 'Not ready' : 'Ready'}</button>`;
    }
    if (me && me.seat >= 0 && me.hp <= 0) return '<h2>You are out</h2>';
    return null;
  }

  dispose() { this.ui.dispose(); }
}
