// ui.css first, so the game's --g-* overrides in style.css win.
import { GameUi, h } from '@gaime/core/ui';
import './style.css';
import { Controls, GameClient, keep, Scope, TouchControls, WASD, watchVersion } from '@gaime/core/client';
import { SoundBank, tones } from '@gaime/core/audio';
import type { Command, Events, Input, Player, World } from '../shared/types';
import { Scene } from './scene';

const app = document.getElementById('app')!;
const scope = new Scope();

// One connection for the whole page life; hot reloads of this module keep it.
const net = keep(import.meta.hot, 'net', () => new GameClient<World, Input, Command, Events>({ game: 'blank' }));
net.off();

const surface = h('div', { class: 'stage' });
app.append(surface);
scope.add(() => surface.remove());
const scene = scope.add(new Scene(surface));
const controls = scope.add(new Controls({ element: surface, actions: {}, axes: { move: WASD } }));
scope.add(new TouchControls(app, controls, { sticks: ['move'] }));

// Lobby, chat (/help, /bot), roster, status, menu, toasts and F3 stats in one line.
const ui = scope.add(new GameUi<World>({
  client: net, parent: app,
  title: 'Blank',
  description: 'The smallest gaime game: walk around and collect things. Add new pickups in src/features/.',
  help: 'WASD move · Enter chat (/bot adds a bot) · F3 network',
  roster: { detail: player => String((player as Player).score) },
  menu: [{ label: 'Reset scores (host)', action: () => net.command({ type: 'reset-scores' }) }],
}));
const score = h('b', {}, '0');
ui.top.append(h('div', {}, h('span', { class: 'g-micro' }, 'SCORE '), score));

// Server bus events listed in `network.events` arrive here (batched per tick).
const sounds = scope.add(new SoundBank({ sounds: { collect: tones([[880, 0.05], [1320, 0.08]]) } }));
scope.add(net.onEvent('pickup.collected', ({ playerId }) => { if (playerId === net.id) sounds.play('collect'); }));

scope.add(net.on('welcome', welcome => { scene.meId = welcome.id; }));
scope.add(net.on('world', world => {
  scene.update(world);
  score.textContent = String(world.players[net.id]?.score ?? 0);
}));
if (net.world) { scene.meId = net.id; scene.update(net.world); }

scope.add(scene.stage.onFrame(() => {
  controls.update();
  const move = ui.typing ? { x: 0, y: 0 } : controls.axis('move');
  // Screen "up" is -z for a camera looking down the -Z axis.
  const input: Input = { mx: move.x, mz: -move.y };
  scene.input = net.connected ? input : undefined;
  net.input(input);
}));
scope.add(watchVersion({ onUpdate: () => ui.toasts.show('New version — reloading…') }));

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => scope.dispose());
}
