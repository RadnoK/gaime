// ui.css first, so the game's --g-* overrides in style.css win.
import '@gaime/core/ui';
import './style.css';
import { Controls, GameClient, keep, Scope, TouchControls, WASD, watchVersion } from '@gaime/core/client';
import { SoundBank, tones } from '@gaime/core/audio';
import type { Command, Events, Input, World } from '../shared/types';
import { createModels } from './features';
import { Hud } from './hud';
import { Arena } from './scene';

const app = document.getElementById('app')!;
const scope = new Scope();

// The network connection survives client hot reloads; the scene and HUD are rebuilt around it.
const net = keep(import.meta.hot, 'net', () => new GameClient<World, Input, Command>({ game: 'starter' }));
net.off();

const surface = document.createElement('div');
surface.className = 'stage';
app.append(surface);
scope.add(() => surface.remove());
const arena = scope.add(new Arena(surface, createModels()));
const controls = scope.add(new Controls({
  element: surface,
  actions: {
    fire: ['Mouse0', 'Pad:RT', 'Touch:fire'],
    ability1: ['KeyQ', 'Pad:LB', 'Touch:q'],
    ability2: ['KeyE', 'Pad:RB', 'Touch:e'],
    arsenal: ['Tab', 'Pad:Y'],
    mute: ['KeyM'],
  },
  axes: { move: WASD, aim: { stick: 'right', touch: 'aim' } },
}));
scope.add(new TouchControls(app, controls, { sticks: ['move', 'aim'], buttons: [{ name: 'fire', label: '●' }, { name: 'q', label: 'Q' }, { name: 'e', label: 'E' }] }));
const sounds = scope.add(new SoundBank({
  sounds: {
    wave: tones([[330, 0.12], [440, 0.12], [660, 0.2]]),
    cleared: tones([[660, 0.1], [880, 0.18]]),
    down: tones([[220, 0.25], [150, 0.3]]),
    lost: tones([[300, 0.3], [200, 0.3], [120, 0.5]]),
  },
}));

const hud = scope.add(new Hud(app, net, {
  start: () => net.command({ type: 'start' }),
  restart: () => net.command({ type: 'restart' }),
  equip: (slot, ability) => net.command({ type: 'equip', slot, ability }),
  ranking: () => {
    net.request<Array<{ name: string; kills: number; online: boolean }>>('scoreboard')
      .then(rows => hud.notice(rows.map((row, i) => `${i + 1}. ${row.name}${row.online ? '' : ' (offline)'} — ${row.kills}`).join('\n') || 'No players.'))
      .catch(error => hud.notice(error.message));
  },
}));

scope.add(net.on('welcome', welcome => { arena.localId = welcome.id; }));
scope.add(net.on('world', world => { arena.update(world); hud.render(world); }));
// Server bus events listed in `network.events` (batched per tick), plus `sim.emit('sound', { kind })` from modules.
const cues: Partial<Record<string, string>> = { 'wave.started': 'wave', 'wave.cleared': 'cleared', 'round.lost': 'lost' };
scope.add(net.on('event', (name, data) => {
  if (name === 'player.downed') {
    if ((data as Events['player.downed']).playerId !== net.id) return;
    sounds.play('down');
    arena.rig.shake(0.5);
    controls.rumble(0.8, 200);
    return;
  }
  const kind = name === 'sound' ? (data as { kind?: string })?.kind : cues[name];
  if (kind) sounds.play(kind);
}));
if (net.world) { arena.localId = net.id; arena.update(net.world); hud.render(net.world); }

let aim = { x: 0, z: 1 };
scope.add(arena.stage.onFrame(() => {
  controls.update();
  const typing = hud.typing;
  const pointer = controls.pointer;
  const me = arena.me;
  const stick = controls.axis('aim');
  if (me && (stick.x || stick.y)) aim = { x: me.x + stick.x * 8, z: me.z - stick.y * 8 };
  else if (pointer.inside) aim = arena.aim(pointer.x, pointer.y) ?? aim;
  // The camera looks towards -Z: "up" on screen is -z in the world.
  const move = typing ? { x: 0, y: 0 } : controls.axis('move');
  const input: Input = { mx: move.x, mz: -move.y, ax: aim.x, az: aim.z, fire: !typing && (controls.down('fire') || !!(stick.x || stick.y)) };
  arena.input = net.connected ? input : undefined;
  net.input(input);
  if (typing) return;
  if (controls.pressed('ability1')) net.command({ type: 'cast', slot: 0, x: aim.x, z: aim.z });
  if (controls.pressed('ability2')) net.command({ type: 'cast', slot: 1, x: aim.x, z: aim.z });
  if (controls.pressed('arsenal')) hud.toggleArsenal();
  if (controls.pressed('mute')) hud.notice(sounds.toggleMute() ? 'Sound off' : 'Sound on');
}));
scope.listen(window, 'keydown', event => { if (event.code === 'Tab' && !hud.typing) event.preventDefault(); });
scope.add(watchVersion({ onUpdate: () => hud.notice('New game version — reloading…') }));

// Must be the literal `import.meta.hot.accept()` — Vite detects HMR boundaries statically.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => scope.dispose());
}
