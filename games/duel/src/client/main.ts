// ui.css first, so the game's --g-* overrides in style.css win.
import { h } from '@gaime/core/ui';
import './style.css';
import { SoundBank, tones } from '@gaime/core/audio';
import { Controls, GameClient, keep, Scope, TouchControls, WASD, watchVersion } from '@gaime/core/client';
import type { Command, Input, World } from '../shared/types';
import { RULES } from '../shared/rules';
import { Hud } from './hud';
import { Battlefield } from './scene';
import { activeId } from './util';

const app = document.getElementById('app')!;
const scope = new Scope();
const net = keep(import.meta.hot, 'net', () => new GameClient<World, Input, Command>({ game: 'duel' }));
net.off();

const surface = h('div', { class: 'stage' });
app.append(surface);
scope.add(() => surface.remove());
const field = scope.add(new Battlefield(surface));
const controls = scope.add(new Controls({ element: surface, actions: { fire: ['Space', 'Pad:A', 'Touch:fire'] }, axes: { move: WASD } }));
scope.add(new TouchControls(app, controls, { sticks: ['move'], buttons: [{ name: 'fire', label: '💥' }] }));
const hud = scope.add(new Hud(app, net));
const sounds = scope.add(new SoundBank({
  sounds: {
    fire: tones([[180, 0.08], [120, 0.12]], 'square', 0.06),
    boom: tones([[90, 0.25], [60, 0.35]], 'sawtooth', 0.08),
    start: tones([[440, 0.1], [660, 0.16]]),
    tick: tones([[880, 0.05]]),
    win: tones([[523, 0.12], [659, 0.12], [784, 0.25]]),
  },
}));

scope.add(net.on('welcome', welcome => { field.meId = welcome.id; }));
scope.add(net.on('world', world => { field.update(world); hud.render(world); }));
scope.add(net.on('event', (name, data) => {
  if (name !== 'sound') return;
  const kind = (data as { kind: string }).kind;
  sounds.play(kind);
  if (kind === 'boom') { field.rig.shake(0.6); controls.rumble(0.7, 180); }
}));
if (net.world) { field.meId = net.id; field.update(net.world); hud.render(net.world); }

let aim: number | undefined;
let charge = 0;
scope.add(field.stage.onFrame(dt => {
  controls.update();
  const world = net.world;
  const me = world?.players[net.id];
  if (!world || !me) return;
  const myTurn = world.match.phase === 'playing' && activeId(world) === me.id && !world.shotFired;
  const axis = hud.typing ? { x: 0, y: 0 } : controls.axis('move');
  // Our aim is predicted locally while it is our turn; otherwise follow the server.
  if (!myTurn || aim === undefined) aim = me.aim;
  // W/S turn the barrel up/down relative to the side you face.
  const towardsLeft = aim > 90;
  if (myTurn) aim = Math.max(0, Math.min(180, aim + axis.y * RULES.aimSpeed * dt * (towardsLeft ? -1 : 1)));
  field.localAim = myTurn ? aim : undefined;
  net.input({ move: myTurn || world.retreatUntil > world.time ? axis.x : 0, aim });

  // Hold to charge, release to fire; a full bar fires by itself.
  if (myTurn && controls.down('fire') && !hud.typing) charge = Math.min(1, charge + dt / RULES.chargeSeconds);
  const release = charge > 0 && (!controls.down('fire') || charge >= 1);
  if (release && myTurn) net.command({ type: 'fire', power: charge });
  if (release || !myTurn) charge = 0;
  field.charge = charge;
  hud.setCharge(charge);

  // 1–9 pick a weapon from the bar.
  for (let i = 1; i <= 9; i++) {
    if (!controls.keyboard.consume(`Digit${i}`) || hud.typing) continue;
    const weapon = world.catalog.filter(entry => entry.kind === 'weapons' && !entry.hidden)[i - 1];
    if (weapon) net.command({ type: 'weapon', id: weapon.id });
  }
}));
scope.listen(window, 'keydown', event => { if (event.code === 'Space' && !hud.typing) event.preventDefault(); });
scope.add(watchVersion({ onUpdate: () => hud.ui.toasts.show('New version — reloading…') }));

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => scope.dispose());
}
