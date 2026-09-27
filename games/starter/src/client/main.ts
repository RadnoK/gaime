import './style.css';
import { GameClient, Keyboard, Pointer, watchVersion } from '@gaime/core/client';
import type { Command, Input, World } from '../shared/types';
import { createModels } from './features';
import { Hud } from './hud';
import { Sounds } from './audio';
import { Arena } from './scene';

const app = document.getElementById('app')!;
// The network connection survives client hot reloads; the scene and HUD are rebuilt around it.
const net: GameClient<World, Input, Command> = import.meta.hot?.data.net ?? new GameClient<World, Input, Command>({ game: 'starter' });
if (import.meta.hot) import.meta.hot.data.net = net;
net.off();

const surface = document.createElement('div');
surface.className = 'stage';
app.append(surface);
const arena = new Arena(surface, createModels());
const keyboard = new Keyboard();
const pointer = new Pointer(surface);
const abort = new AbortController();
const sounds = new Sounds();

const hud = new Hud(app, {
  join: name => { hud.hideLobby(); void net.join(name); },
  start: () => net.command({ type: 'start' }),
  restart: () => net.command({ type: 'restart' }),
  togglePause: () => net.command({ type: net.world?.pause ? '$resume' : '$pause' }),
  equip: (slot, ability) => net.command({ type: 'equip', slot, ability }),
  chat: text => net.chat(text),
  leave: () => { void net.leave().then(() => hud.showLobby(net.lastName)); },
  ranking: () => {
    net.request<Array<{ name: string; kills: number; online: boolean }>>('scoreboard')
      .then(rows => hud.notice(rows.map((row, i) => `${i + 1}. ${row.name}${row.online ? '' : ' (offline)'} — ${row.kills}`).join('\n') || 'No players.'))
      .catch(error => hud.notice(error.message));
  },
});

net.on('welcome', welcome => { arena.localId = welcome.id; hud.hideLobby(); });
net.on('world', world => { arena.update(world); hud.render(world, net.id, net.ping); });
net.on('notice', text => hud.notice(text));
net.on('event', (name, data) => { if (name === 'sound') sounds.play((data as { kind: string }).kind); });
net.on('status', (state, text) => {
  hud.status(state, text);
  if (state === 'full' || state === 'replaced' || state === 'removed') hud.showLobby(net.lastName, text);
});

if (net.world) {
  // Hot reload: the connection is already there, just redraw.
  arena.localId = net.id;
  arena.update(net.world);
  hud.render(net.world, net.id, net.ping);
  hud.status(net.state, net.connected ? 'Connected' : '…');
} else if (net.savedName) {
  // Page reload: straight back into the game with the same character.
  void net.join(net.savedName);
} else {
  hud.showLobby(net.lastName);
}

let aim = { x: 0, z: 1 };
let showNet = false;
// F3: client network stats plus server tick/publish costs (latency testing: add ?lag=150&jitter=40&loss=5).
const netTimer = setInterval(async () => {
  if (!showNet) return;
  const s = net.stats;
  let server = '';
  try {
    const stats = await (await fetch('/gaime/stats', { cache: 'no-store' })).json();
    server = `\nserver: tick ${stats.tickMs.avg}/${stats.tickMs.max} ms · publish ${stats.publishMs.avg} ms · patch ${stats.patchBytes.max} B\nevent loop p99 ${stats.eventLoopDelayMs.p99} ms · clients ${stats.clients} · RAM ${stats.memoryMb} MB${stats.workers.length ? `\nworkers: ${stats.workers.map((w: { name: string; size: number; done: number; avgMs: number }) => `${w.name} ×${w.size} (${w.done} tasks, ${w.avgMs} ms)`).join(', ')}` : ''}`;
  } catch {}
  const simulated = s.simulated ? `\nsimulated: lag ${s.simulated.lag} ms ± ${s.simulated.jitter} · loss ${s.simulated.loss}%` : '';
  hud.netStats(`ping ${s.ping === undefined ? '—' : Math.round(s.ping)} ms · patches ${s.patchesPerSecond}/s · ~${(s.bytesPerSecond / 1024).toFixed(1)} KB/s\ninput ${s.inputsPerSecond}/s · resync ${s.resyncs}${simulated}${server}`);
}, 500);
const stopFrame = arena.stage.onFrame(() => {
  const typing = hud.typing;
  const point = pointer.inside ? arena.aim(pointer.x, pointer.y) : undefined;
  if (point) aim = point;
  const input: Input = {
    mx: typing ? 0 : keyboard.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
    mz: typing ? 0 : keyboard.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
    ax: aim.x, az: aim.z,
    fire: !typing && pointer.buttons.has(0),
  };
  arena.input = net.connected ? input : undefined;
  net.input(input);
  if (keyboard.consume('KeyQ')) net.command({ type: 'cast', slot: 0, x: aim.x, z: aim.z });
  if (keyboard.consume('KeyE')) net.command({ type: 'cast', slot: 1, x: aim.x, z: aim.z });
  if (keyboard.consume('Tab')) hud.toggleArsenal();
  if (keyboard.consume('KeyM')) hud.notice(sounds.toggle() ? 'Sound off' : 'Sound on');
  if (keyboard.consume('F3')) showNet = hud.toggleNetStats();
  if (keyboard.consume('Enter')) {
    const world = net.world;
    if (world && (world.phase === 'lost' || (world.phase === 'lobby' && world.hostId === net.id))) hud.primaryAction();
    else hud.focusChat();
  }
});
window.addEventListener('keydown', event => { if ((event.code === 'Tab' || event.code === 'F3') && !hud.typing) event.preventDefault(); }, { signal: abort.signal });

const stopVersion = watchVersion({ onUpdate: () => hud.notice('New game version — reloading…') });

// Must be the literal `import.meta.hot.accept()` — Vite detects HMR boundaries statically.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    stopFrame(); stopVersion(); abort.abort(); clearInterval(netTimer); sounds.dispose();
    keyboard.dispose(); pointer.dispose();
    hud.dispose(); arena.dispose(); surface.remove();
  });
}
