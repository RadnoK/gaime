// ui.css first, so the game's --g-* overrides in style.css win.
import { escapeHtml, GameUi, h, meter, Writer } from '@gaime/core/ui';
import './style.css';
import { Controls, GameClient, keep, Scope, TouchControls, WASD, watchVersion } from '@gaime/core/client';
import { SoundBank, tones } from '@gaime/core/audio';
import { matchTimeLeft } from '@gaime/core/kit';
import type { Command, Events, Input, Player, World } from '../shared/types';
import { dashLeft, RULES } from '../shared/rules';
import { Scene } from './scene';

const app = document.getElementById('app')!;
const scope = new Scope();

// One connection for the whole page life; hot reloads of this module keep it.
const net = keep(import.meta.hot, 'net', () => new GameClient<World, Input, Command, Events>({ game: 'bumper' }));
net.off();

const surface = h('div', { class: 'stage' });
app.append(surface);
scope.add(() => surface.remove());
const scene = scope.add(new Scene(surface));
const controls = scope.add(new Controls({ element: surface, actions: { dash: ['Space', 'Pad:A', 'Touch:dash'] }, axes: { move: WASD } }));
scope.add(new TouchControls(app, controls, { sticks: ['move'], buttons: [{ name: 'dash', label: '💨' }] }));

// Lobby, chat (/help, /bot), roster, status, menu, toasts and F3 stats in one line.
const ui = scope.add(new GameUi<World>({
  client: net, parent: app,
  title: 'Bumper',
  description: 'Sumo on ice: push the other discs off the arena. Last one standing wins the round. Type /bot in the chat to add opponents.',
  help: 'WASD steer · Space dash · Enter chat (/bot adds a bot) · F3 network',
  roster: { detail: player => `${(player as Player).wins} 🏆` },
  actions: { ready: () => net.command({ type: 'ready' }) },
}));
const writer = new Writer();
const round = h('b', {}, 'LOBBY');
const wins = h('b', {}, '0');
const dash = meter('var(--g-accent)');
ui.top.append(h('div', {}, round), h('div', {}, h('span', { class: 'g-micro' }, 'WINS '), wins));
ui.center.append(h('div', { class: 'dash' }, h('span', { class: 'g-micro' }, 'DASH'), dash.element));

function banner(world: World, me?: Player): string | null {
  if (world.pause?.reason === 'error') return `<h2>⚠ Game paused — code error</h2><p>${escapeHtml(world.pause.message ?? '')}</p>`;
  if (world.pause) return '<h2>Paused</h2>';
  const { match } = world;
  const players = Object.values(world.players).filter(p => p.online);
  if (match.phase === 'countdown') return `<h2>${Math.ceil(matchTimeLeft(match, world.time))}</h2><p>Round ${match.round + 1} — push them off!</p>`;
  if (match.phase === 'ended') {
    const winner = match.winner ? world.players[match.winner] : undefined;
    const title = !winner ? 'Draw!' : winner.id === net.id ? '🏆 You win!' : `${escapeHtml(winner.name)} wins`;
    return `<h2>${title}</h2><p class="g-micro">${players.map(p => `${escapeHtml(p.name)} ${p.wins}`).join(' · ')}</p><button data-action="ready">Next round</button>`;
  }
  if (match.phase === 'lobby') {
    if (players.length < 2) return '<h2>Waiting for opponents</h2><p class="g-micro">Share this page\'s address, or type <b>/bot</b> in the chat (host).</p>';
    const list = players.map(p => `${escapeHtml(p.name)} ${match.ready[p.id] ? '✓' : '…'}`).join(' · ');
    return `<h2>Bumper</h2><p class="g-micro">${list}</p><button data-action="ready">${match.ready[net.id] ? 'Not ready' : 'Ready'}</button>`;
  }
  if (me && !me.alive) return '<h2>You are out</h2><p class="g-micro">Watch the rest of the round.</p>';
  return null;
}

// Server bus events listed in `network.events` arrive here (batched per tick).
const sounds = scope.add(new SoundBank({
  sounds: {
    bump: tones([[140, 0.05], [90, 0.08]], 'square', 0.07),
    dash: tones([[320, 0.04], [640, 0.07]], 'sawtooth', 0.04),
    fall: tones([[500, 0.1], [300, 0.12], [150, 0.2]]),
    pickup: tones([[880, 0.05], [1320, 0.08]]),
    tick: tones([[880, 0.05]]),
    start: tones([[440, 0.1], [660, 0.16]]),
    win: tones([[523, 0.12], [659, 0.12], [784, 0.25]]),
  },
}));
const mine = (id: string) => id === net.id;
scope.add(net.onEvent('player.bumped', ({ a, b, speed }) => {
  sounds.play('bump', { volume: Math.min(1, speed / 15) });
  if (mine(a) || mine(b)) { scene.rig.shake(Math.min(0.5, speed / 30)); controls.rumble(0.6, 120); }
}));
scope.add(net.onEvent('dash.used', ({ player }) => { if (mine(player)) sounds.play('dash'); }));
scope.add(net.onEvent('player.knocked', ({ player }) => { sounds.play('fall', { volume: mine(player) ? 1 : 0.4 }); }));
scope.add(net.onEvent('pickup.collected', ({ player }) => { if (mine(player)) sounds.play('pickup'); }));
scope.add(net.onEvent('round.countdown', () => sounds.play('tick')));
scope.add(net.onEvent('round.started', () => sounds.play('start')));
scope.add(net.onEvent('round.won', ({ player }) => { if (player) sounds.play('win'); }));

function render(world: World) {
  scene.update(world);
  const me = world.players[net.id];
  writer.text(round, world.match.phase === 'playing' ? `ROUND ${world.match.round} · ${Object.values(world.players).filter(p => p.alive).length} LEFT` : world.match.phase.toUpperCase());
  writer.text(wins, String(me?.wins ?? 0));
  ui.banner.set(banner(world, me));
}
scope.add(net.on('welcome', welcome => { scene.meId = welcome.id; }));
scope.add(net.on('world', render));
if (net.world) { scene.meId = net.id; render(net.world); }

scope.add(scene.stage.onFrame(() => {
  controls.update();
  const move = ui.typing ? { x: 0, y: 0 } : controls.axis('move');
  // Screen "up" is -z for a camera looking down the -Z axis.
  const input: Input = { mx: move.x, mz: -move.y };
  net.input(input);
  if (controls.pressed('dash') && !ui.typing) net.command({ type: 'dash', x: input.mx, z: input.mz });
  const me = net.world?.players[net.id];
  dash.set(me ? 1 - dashLeft(me, net.world!.time) / RULES.dashCooldown : 0);
}));
scope.listen(window, 'keydown', event => { if (event.code === 'Space' && !ui.typing) event.preventDefault(); });
scope.add(watchVersion({ onUpdate: () => ui.toasts.show('New version — reloading…') }));

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => scope.dispose());
}
