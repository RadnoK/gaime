# Client

The browser side of a gaime game: the connection to the room, input, and optional helpers for the HUD, the Three.js scene, models, effects, camera and sound. The server is described in [SERVER.md](SERVER.md) and [SIMULATION.md](SIMULATION.md), the wire protocol in [PROTOCOL.md](PROTOCOL.md), the gameplay helpers shared with the server in [KIT.md](KIT.md), and how the pieces fit together in [ARCHITECTURE.md](ARCHITECTURE.md).

**What players see is the game's own design.** The framework's job on the client is the connection (`GameClient`: identity, patches, commands, events, reconnection) and hot-reload safety (`Scope`, `keep`). `GameUi`, `@gaime/core/three` and `@gaime/core/audio` are **optional, replaceable defaults** — a quick way to get a lobby, chat and a 3D view while the game's real interface does not exist yet. A game can restyle them, use only some of them, or replace all of them with its own DOM, canvas, 2D renderer, engine or UI framework; nothing on the server depends on them.

## Overview

| Import | Contents |
| --- | --- |
| `@gaime/core/client` (the part every game needs) | `GameClient`, `watchVersion`, `Keyboard`, `Pointer`, `isTyping`, `Controls`, `TouchControls`, `WASD`, `PAD_BUTTONS`, `ServerClock`, `Interpolator`, `Scope`, `keep`, `createFeatureModules` |
| `@gaime/core/three` (optional) | `createStage`, `disposeObject`, `pickGround`, `ModelLibrary`, `loadGltf`, `createLabel`, `setLabel`, `EntityLayer`, `disposeOwned`, `CameraRig`, `CAMERA`, `createBar`, `setBar`, `faceCamera`, `EffectsLayer`, `builtinEffects` |
| `@gaime/core/ui` (optional) | `GameUi`, `Lobby`, `Toasts`, `ChatBox`, `Roster`, `Banner`, `Dialog`, `StatusPill`, `h`, `escapeHtml`, `Writer`, `meter` (importing it also loads `ui.css`) |
| `@gaime/core/audio` (optional) | `SoundBank`, `tones` |
| `@gaime/core` | shared types (`BaseWorld`, `BasePlayer`, `Visual`, `Welcome`, …) and math (`dist`, `damp`, `wrapAngle`, …) |

The example games' clients are usually four files:

```text
src/client/main.ts    wiring: GameClient, Scope, scene, HUD, controls, sounds, HMR
src/client/scene.ts   Three.js view: stage, entity layers, interpolation, prediction, camera
src/client/hud.ts     GameUi plus the game's own widgets (optional; blank puts it in main.ts)
src/client/style.css  game styles and --g-* theme overrides
```

The data flow is one-way. The server sends a full snapshot (`welcome`) and then delta patches at about 15 Hz. `GameClient` rebuilds a new immutable `world` object from every patch and emits it. The scene stores it and draws it every animation frame. Input goes back through `net.input()` (continuous, throttled) and `net.command()` (discrete actions).

## A minimal `main.ts`

This is `games/blank/src/client/main.ts`, the smallest complete client. It uses the optional defaults (`GameUi`, a Three.js `Scene`, `SoundBank`); the parts every client needs regardless of its look are `GameClient` kept with `keep`, the `Scope`, the event and world listeners, `net.input` and the HMR block.

```ts
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
```

`index.html` only needs `<div id="app"></div>` and `<script type="module" src="/src/client/main.ts"></script>`. `style.css` makes `#app` fill the window (`position: relative`) and `.stage` fill `#app` (`position: absolute; inset: 0; touch-action: none`). Every line of the HMR pattern is explained in [Hot reload rules](#hot-reload-rules).

## GameClient

```ts
new GameClient<W extends BaseWorld, I = unknown, C extends { type: string } = { type: string }, E = Record<string, any>>(options: GameClientOptions)
```

`W` is the world type, `I` the continuous input, `C` the union of game commands and `E` the game's `Events` (types `onEvent`).

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `game` | required | Same as `GameDefinition.name`. The client uses it only as the prefix of its browser storage keys (`gaime:<game>…`). The room is looked up through `GET /gaime/room`. |
| `url` | `location.origin` | Game server address, `http(s)://` or `ws(s)://`. Both the WebSocket and `GET /gaime/room` go to that server (a `ws(s)` address is fetched over `http(s)`). In dev and in production the page and the server share one port, so you rarely need it. |
| `identity` | `'browser'` | `'browser'`: the ticket (player identity) is kept in `localStorage`, so there is one character per browser profile, and a second tab takes that character over. `'tab'`: the ticket is kept in `sessionStorage`, so every tab is a separate player. |
| `simulate` | from the URL | `{ lag?, jitter?, loss? }`, see [Network simulation](#network-simulation). Each field overrides the matching URL parameter. |

`?player=<name>` in the page URL (letters, digits, `_` and `-`, at most 24 characters) adds a suffix to the storage prefix (`gaime:<game>:<name>`). This gives you a separate local identity, so two players can run in one browser: `http://localhost:5173/?player=2`.

### Members

| Member | Description |
| --- | --- |
| `id: string` | Your player id, set on every `welcome`. Empty before the first one. |
| `world?: W` | The latest world. `undefined` before the first `welcome`. |
| `state: ConnectionState` | See [Connection states](#connection-states). |
| `connected: boolean` | `state === 'connected'`. |
| `ping?: number` | Round trip in ms, refreshed every 2 s (includes simulated lag). Cleared when the connection drops. |
| `stats: NetStats` | Rolling one-second network statistics (see below). |
| `ticket: string` | The identity token sent on join. It is generated on first read and then stored. |
| `savedName: string` | The name of the last `join` in this tab (`sessionStorage`). `GameUi` uses it to rejoin after a page reload without showing the lobby. It is cleared by `leave()`, `removed` and `replaced`. |
| `lastName: string` | The last name used in this browser (`localStorage`), used to prefill the lobby. Both names follow a rename on the server (`/nick`), so a later rejoin sends the current name. |
| `on(event, listener): () => void` | Subscribe. Returns an unsubscribe function (pass it to `scope.add`). |
| `onEvent(name, listener): () => void` | Subscribe to one server event by name; with the fourth type parameter (`GameClient<World, Input, Command, Events>`) the payload is typed from the game's `Events`. Returns an unsubscribe function. |
| `off()` | Remove every listener of every event. Used after a hot reload (see below). |
| `join(name): Promise<void>` | Trims the name to 24 characters, stores it and connects. It reuses the tab's reconnection token when one exists, and otherwise joins the shared room with `{ name, ticket }`. |
| `input(input: I)` | Continuous input (movement, aim), see [Input and commands](#input-and-commands). |
| `command(command: C \| EngineCommand \| { type: '<module>-<action>', … }): boolean` | A discrete action. Module commands (`<module>-<action>`) are accepted without being part of the game's `Command` type. Returns `false` (and sends nothing) when not connected. |
| `chat(text): boolean` | Same as `command({ type: '$chat', text })`. Slash commands such as `/help` go through here too. |
| `request<T>(name, payload?, timeout = 5000): Promise<T>` | RPC to `GameDefinition.requests[name]`. |
| `leave(): Promise<void>` | Leave on purpose. The character stays in the world unless the game frees seats (`keepPlayers: false`). The state becomes `idle` and no reconnection happens. |
| `dispose()` | Drop the socket without leaving and remove all listeners. The server treats this as a network drop, so the seat is kept for `reconnectSeconds`. |

### Events

| Event | Listener | When |
| --- | --- | --- |
| `world` | `(world: W, previous: W \| undefined) => void` | After every `welcome` and every applied patch. |
| `status` | `(state: ConnectionState, text: string) => void` | On every state change. `text` is a readable description or the error message. |
| `notice` | `(text: string) => void` | A private server notice (for example, a rejected command), and also Colyseus room errors that carry text. |
| `welcome` | `(welcome: Welcome) => void` | On every full snapshot: the first join, every reconnect, every resync and every server hot reload. `Welcome` is `{ id, game, version, protocol, revision, host }`. |
| `event` | `(name: string, data: unknown) => void` | One-off server events: `ctx.emit(name, data)`, and bus events the game lists in `network.events` (their payload is the bus payload, e.g. `Events['pickup.collected']`). For sounds, screen shakes, hit markers. They arrive batched — all events of one server tick in one message, delivered to your listener one by one in order — and are not stored in the world, so a client that joins later never sees them. At most 256 per tick reach one client. |

`welcome` fires many times per session, so its handler must be idempotent (assign `scene.meId = welcome.id` rather than creating objects).

Type the payloads of forwarded events with the game's `Events` type from `src/shared/types.ts` — the client may import it, since `shared` is common to both sides — and subscribe by name:

```ts
const net = keep(import.meta.hot, 'net', () => new GameClient<World, Input, Command, Events>({ game: 'blank' }));
scope.add(net.onEvent('pickup.collected', ({ playerId }) => { if (playerId === net.id) sounds.play('collect'); }));
```

```ts
// games/starter/src/client/main.ts
scope.add(net.on('welcome', welcome => { arena.localId = welcome.id; }));
scope.add(net.on('world', world => { arena.update(world); hud.render(world); }));
scope.add(net.on('event', (name, data) => {
  if (name !== 'sound') return;
  const kind = (data as { kind: string }).kind;
  sounds.play(kind);
  if (kind === 'down') { arena.rig.shake(0.5); controls.rumble(0.8, 200); }
}));
```

### Received worlds are immutable

Patches are applied with structural sharing. Every patch creates a new top-level world object. Top-level keys and entities that did not change keep the same object reference as in the previous world. Two things follow from this:

- **Never mutate a received world** or anything reachable from it. The next patch is merged onto that same data, so a mutation leaks into every later world and makes your view differ from the server's without any error. Keep predicted or animated values in your own objects (`this.local` in the example scenes). Copy arrays before sorting them (`Object.values(...)`, `.filter(...)` and `.slice()` already return new arrays).
- **Reference comparison is a cheap change check.** `games/duel/src/client/scene.ts` rebuilds the terrain mesh only when the array itself changed:

```ts
if (world.terrain !== this.terrainSource) this.rebuildTerrain(world.terrain);
```

### Input and commands

`input()` is for state that holds continuously, such as a movement vector, an aim point or a held fire button. Call it every frame with the whole current input. An `InputGate` inside decides what is actually sent:

- Changed input is sent at most every 33 ms.
- Unchanged input is repeated every 150 ms, so the server's input lease (400 ms by default, `inputLeaseMs`) never expires while the player holds a key.
- Nothing is sent while not connected. If the connection is lost, the lease runs out and the character stops.

`command()` is for discrete actions (cast, fire, equip, start). Commands are never dropped by the simulated loss. Engine commands start with `$` (`$chat`, `$pause`, `$resume`). Games must not use that prefix for their own command types.

```ts
// games/starter/src/client/main.ts — one frame of input
const move = typing ? { x: 0, y: 0 } : controls.axis('move');
const input: Input = { mx: move.x, mz: -move.y, ax: aim.x, az: aim.z, fire: !typing && (controls.down('fire') || !!(stick.x || stick.y)) };
arena.input = net.connected ? input : undefined;
net.input(input);
if (typing) return;
if (controls.pressed('ability1')) net.command({ type: 'cast', slot: 0, x: aim.x, z: aim.z });
```

`request()` rejects in these cases: immediately when not connected, when no answer arrives within `timeout` ms, when the server handler throws (the promise rejects with its message), and when the connection drops or you leave while the request is pending.

```ts
net.request<Array<{ name: string; kills: number; online: boolean }>>('scoreboard')
  .then(rows => hud.notice(rows.map((row, i) => `${i + 1}. ${row.name}${row.online ? '' : ' (offline)'} — ${row.kills}`).join('\n') || 'No players.'))
  .catch(error => hud.notice(error.message));
```

### Connection states

`type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'full' | 'replaced' | 'removed' | 'error'`

| State | Default text | Meaning and behaviour |
| --- | --- | --- |
| `idle` | Disconnected | Before `join()` and after `leave()`. |
| `connecting` | Connecting… | The first connection attempt. |
| `connected` | Connected | Joined. `input`, `command` and `request` work. |
| `reconnecting` | Reconnecting… | The socket dropped. Colyseus retries up to 8 times (at most 1 s apart). If it gives up (for example after a server restart), the client joins again with the same ticket after 1 s. |
| `error` | the error message | The join failed (server unavailable, `/gaime/room` not OK). The client retries every 2 s. |
| `full` | the server message | `maxPlayers` reached (HTTP 403). No retry. |
| `replaced` | The game was opened in another tab. | The same identity joined elsewhere (close code 4103). Final. |
| `removed` | You were removed from the game. | Kicked (close code 4102 or the `removed` message). Final. |

`full`, `replaced` and `removed` are terminal: the client stops reconnecting, and `GameUi` shows the lobby with the text. During `reconnecting` the snapshot is discarded and patches are ignored. When the connection comes back, the client sends `hello` and gets a fresh `welcome`. A patch that does not fit the current snapshot (lost or out of order) triggers the same resync and is counted in `stats.resyncs`.

### NetStats

```ts
interface NetStats {
  ping?: number;              // measured round trip (plus simulated lag)
  patchesPerSecond: number;
  bytesPerSecond: number;     // approximate: JSON size of the patches received in the last second
  inputsPerSecond: number;
  resyncs: number;            // total full snapshots requested after a bad patch
  simulated?: { lag: number; jitter: number; loss: number };  // only when a simulation is active
}
```

`GameUi` shows these numbers, plus server costs from `/gaime/stats`, in the F3 panel.

### Network simulation

Use this to test prediction and interpolation on a realistic network. You can set it through the URL:

```text
http://localhost:5173/?lag=150&jitter=40&loss=5
```

or in code: `new GameClient({ game: 'starter', simulate: { lag: 150, jitter: 40, loss: 5 } })`.

| Parameter | Effect |
| --- | --- |
| `lag` | Round trip in ms. Each direction (outgoing messages and incoming handlers) is delayed by `lag / 2`. |
| `jitter` | Random spread in ms: each one-way delay varies uniformly within ±`jitter / 2`. Message order is preserved, as on TCP. |
| `loss` | Percentage (capped at 100) of **`input` messages** dropped. Commands, requests and chat are never dropped. |

`ping` and `stats.ping` include the simulated `lag`. The console logs `[gaime] simulated network {…}` when a simulation is active. For a delay on the server side for every client, use `GAIME_LATENCY_MS` (see [PROTOCOL.md](PROTOCOL.md#latency-and-load-testing)).

### watchVersion

```ts
watchVersion(options?: { interval?: number; onUpdate?: (version: string) => void }): () => void
```

A production build cannot hot-reload. `watchVersion` polls `/health` every `interval` ms (default 3000). When the server reports a version different from the one the page was built with, it calls `onUpdate` and reloads the page 300 ms later. Identity and reconnection survive the reload, so the player lands straight back in the game. A `sessionStorage` guard prevents a reload loop when a stale `index.html` is cached. In dev (`import.meta.env.PROD` false) it does nothing, because Vite HMR delivers new code. It returns a stop function, so pass it to `scope.add`.

## HUD: GameUi

`GameUi` is an optional default HUD, wired to a `GameClient`: a lobby, a connection status pill with ping, a ☰ menu, the roster, the feed with chat, toasts for notices, a centred banner and the F3 network panel. It is useful while prototyping and for development tools (chat commands like `/bot`, F3 stats); the look is themable (`--g-*` variables) and every component can be used alone or left out. A game with its own interface does not need it — `GameClient` exposes everything it shows (`world.feed`, `world.players`, `net.chat`, `net.stats`, `status` and `notice` events).

```ts
// games/starter/src/client/hud.ts
this.ui = new GameUi<World>({
  client: net, parent,
  title: 'Crystal',
  description: 'Defend the crystal against waves of monsters. …',
  help: 'WASD move · mouse aim/shoot · Q/E abilities · Tab arsenal · Enter chat (/help, /bot) · M sound · F3 network',
  roster: { detail: player => String((player as Player).kills) },
  menu: [{ label: 'Ranking', action: () => actions.ranking() }],
  actions: { start: () => actions.start(), restart: () => actions.restart() },
  onEnter: () => this.primaryAction(),
});
this.ui.top.append(h('div', { class: 'wave' }, this.wave, this.phase));
this.ui.center.append(h('div', { class: 'vitals' }, this.health.element, this.healthText), this.abilities);
this.arsenal = this.ui.dialog('Arsenal', 'Abilities from every module in src/features/*. Click Q or E to bind.');
```

### Options (`GameUiOptions<W>`)

| Option | Default | Meaning |
| --- | --- | --- |
| `client` | required | The `GameClient`. |
| `parent` | required | Usually `document.getElementById('app')`. |
| `title` | required | Lobby heading. |
| `description` | — | Lobby text under the title. |
| `help` | `''` | Controls hint in the bottom-right corner. |
| `roster` | `{}` | `RosterOptions<W>`, or `false` for no roster. Its `colorOf` also colours names in the chat. |
| `menu` | `[]` | Extra ☰ entries `{ label, action() }`, listed before the built-in "Pause / resume (host)" and "Leave to lobby". |
| `actions` | `{}` | Handlers for `data-action="name"` elements inside the banner. |
| `onEnter` | — | Called when Enter is pressed outside an input. Return `true` if the game used the key (for example, to start a round). Otherwise the chat input gets focus. |
| `autoJoin` | `true` | Rejoin automatically with `client.savedName` after a page reload in the same tab. |
| `netStats` | `true` | Enable the F3 network panel. |

The constructor handles three cases. If the client already has a world (after a hot reload), it renders at once. Otherwise, if `autoJoin` is on and there is a saved name, it joins. Otherwise it shows the lobby. Enter and F3 are ignored while the chat has focus, while the lobby is visible or while any `<dialog>` is open.

### Members

| Member | Description |
| --- | --- |
| `root` | The `.g-hud` element (full-screen, `pointer-events: none` except on controls). |
| `top` | Top bar, left side: wave, score, timers. Each child gets a panel style. |
| `center` | Bottom centre: health, abilities, hotbar. |
| `layer` | Free full-screen overlay for positioned elements. |
| `lobby: Lobby` | The name form. |
| `toasts: Toasts` | `ui.toasts.show(text)`. Server notices appear here automatically. |
| `chat: ChatBox<W>` | The feed and chat input. |
| `roster?: Roster<W>` | `undefined` with `roster: false`. |
| `banner: Banner` | The centred message box. |
| `status: StatusPill` | Connection state and ping. |
| `dialog(title, subtitle?)` | Creates a modal `Dialog` inside the HUD. |
| `toggleNetStats()` | Show or hide the F3 panel. While it is visible, it polls `client.stats` and `/gaime/stats` every 500 ms. |
| `typing` | `true` while the chat input has focus. Ignore game keys then. |
| `render(world)` | Re-renders the chat, the roster and the ping. It is called on every world automatically. |
| `dispose()` | Removes the listeners and the DOM. |

### Components

All of these are exported, so they can also be used without `GameUi`.

| Class | Constructor | API |
| --- | --- | --- |
| `Lobby` | `(parent, { title, description?, button = 'Join', placeholder = 'Your nickname', onJoin(name) })` | `element`, `visible`, `show(name = '', status = '')` (prefills an empty input), `setStatus(text)`, `hide()` |
| `Toasts` | `(parent)` | `show(text, ms = min(12000, 3000 + 40 × length))`. Multi-line text is kept. `dispose()` |
| `ChatBox<W>` | `(parent, { send(text), colorOf?(player), lines = 8, placeholder? })` | `element`, `input`, `typing`, `focus()`, `render(world)` shows the last `lines` feed items. The default `colorOf` is `player.color`. |
| `Roster<W>` | `(parent, { detail?(player, world), colorOf?(player), sort?(a, b), onlineOnly = false })` | `render(world, meId)`. Shows a crown for the host and a robot for bots (`player.data['gaime-bot']`), dims offline players and highlights you. The default sort is online first, then by name. |
| `Banner` | `(parent, actions = {})` | `set(html \| null)` (`null` or empty hides it), `on(action, handler)`. A click on any element with `data-action="name"` calls `actions[name]()`. |
| `Dialog` | `(parent, { title, subtitle? })` | `element` (`HTMLDialogElement`), `body`, `open`, `setContent(html)`, `show()`, `close()`, `toggle()`. It has a Close button. |
| `StatusPill` | `(parent)` | `set(state, text)` (sets `data-state` for styling), `setPing(ms?)` |

`Banner.set`, `Dialog.setContent` and `Writer.html` take **raw HTML**, so escape everything that comes from players with `escapeHtml`. `Roster`'s `detail` is text: it is escaped for you.

```ts
// games/starter/src/client/hud.ts — banner with a button
if (world.phase === 'lost') return `<h2>Crystal destroyed</h2><p>Wave ${world.wave} · score ${world.score}</p><button data-action="restart">New round</button>`;
```

### DOM helpers

| Helper | Description |
| --- | --- |
| `h(tag, attributes?, ...children)` | Creates an element. `on*` function attributes become listeners, `true` becomes an empty attribute, and `false`/`undefined` attributes and `null`/`undefined`/`false` children are skipped. Example: `h('button', { class: 'g-button', onclick: () => start() }, 'Start')`. |
| `escapeHtml(value)` | Escapes `& < > " '`. |
| `Writer` | `html(element, html)` and `text(element, text)` write only when the value changed. Use it for anything re-rendered on every patch (15 times per second). |
| `meter(color = 'var(--g-accent)')` | A horizontal bar: `{ element, set(0..1) }`. |

### Theming

`ui.css` defines these variables on `:root`:

| Variable | Default | Variable | Default |
| --- | --- | --- | --- |
| `--g-bg` | `#0b0f14` | `--g-accent` | `#59e3ff` |
| `--g-panel` | `rgba(12, 17, 24, 0.82)` | `--g-accent-text` | `#041018` |
| `--g-panel-solid` | `#0f151d` | `--g-danger` | `#ff5977` |
| `--g-line` | `rgba(120, 170, 220, 0.18)` | `--g-ok` | `#7dff9b` |
| `--g-text` | `#e6edf3` | `--g-warn` | `#ffd659` |
| `--g-muted` | `#8b98a5` | `--g-radius` | `10px` |
| `--g-font` | system UI stack | `--g-mono` | system monospace stack |

Reusable classes: `g-button` (plus `g-primary`, `g-icon`), `g-input`, `g-micro`, `g-panel`, `g-meter`, `g-stack`. The touch controls are also styled by `ui.css` (`g-touch`, `g-stick`, `g-touch-button`), so `TouchControls` needs `@gaime/core/ui` to be imported somewhere.

The example games import `@gaime/core/ui` **before** `./style.css`, so `ui.css` is loaded first and the game's own `:root` block wins at equal specificity. Override variables in `style.css`:

```css
/* style.css */
:root { --g-accent: #ffd659; --g-accent-text: #1a1400; --g-radius: 4px; }
```

Keep that import order in `main.ts` (a game that uses only `TouchControls` can import it for its side effect: `import '@gaime/core/ui';`).

## Controls

### Controls

`Controls` is one input layer for keyboard, mouse, gamepad and touch. You express input as named **actions** (buttons) and **axes** (2D directions).

```ts
// games/starter/src/client/main.ts
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
```

`ControlsOptions<A, X>`: `element` (receives pointer input, usually the canvas container), `actions: Record<A, Binding[]>`, `axes?: Record<X, AxisBinding>` and `deadZone` (stick dead zone, default `0.15`).

Binding strings:

| Binding | Source |
| --- | --- |
| `'KeyW'`, `'Space'`, `'ArrowLeft'`, `'Digit1'`, `'Tab'` … | `KeyboardEvent.code` (layout-independent) |
| `'Mouse0'`, `'Mouse1'`, `'Mouse2'` | left, middle and right mouse button over `element` |
| `'Pad:<name>'` | a standard gamepad button from `PAD_BUTTONS` |
| `'Touch:<name>'` | an on-screen button from `TouchControls` |

`PAD_BUTTONS`: `A` 0, `B` 1, `X` 2, `Y` 3, `LB` 4, `RB` 5, `LT` 6, `RT` 7, `Back` 8, `Start` 9, `LS` 10, `RS` 11, `Up` 12, `Down` 13, `Left` 14, `Right` 15. A pad button counts as down when it reports `pressed` or when its value is above 0.5.

`AxisBinding`: `{ up?, down?, left?, right?: Binding[]; stick?: 'left' | 'right'; touch?: string }`. The predefined axis `WASD` is `{ up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], stick: 'left', touch: 'move' }`.

| Member | Description |
| --- | --- |
| `update()` | Call **once per frame, before reading**. It polls the first connected gamepad, computes this frame's presses and updates `device`. |
| `down(action)` | Held right now. |
| `pressed(action)` | Became pressed this frame. Keyboard and mouse taps shorter than one frame are still caught. |
| `axis(name)` | `{ x, y }`, each in -1..1, with length ≤ 1. `x` is right and `y` is up/forward. Priority: an active touch stick, then a gamepad stick outside the dead zone, then the keys. |
| `rumble(strength = 0.5, ms = 120)` | Dual-rumble on gamepads that support it. |
| `device` | `'keyboard' \| 'gamepad' \| 'touch'`, the last device used (useful for showing the right prompts). |
| `keyboard: Keyboard`, `pointer: Pointer` | The underlying devices. |
| `touch` | `{ buttons: Set<string>, sticks: Map<string, { x, y }> }`, the virtual state written by `TouchControls`. |
| `dispose()` | Removes the listeners. |

The axis `y` is "up on screen". With a camera looking towards -Z (the `CAMERA.topDown` preset), screen up is world -z, which is why the games send `mz: -move.y`.

### TouchControls

```ts
new TouchControls(parent: HTMLElement, controls: Controls, options?: TouchControlsOptions)
```

These are on-screen joysticks and buttons that feed `controls.touch`. Options:

- `sticks?: string[]`: joystick names, matched by an axis's `touch` binding. The first stick is on the left, the second on the right.
- `buttons?: Array<{ name, label }>`: buttons matched by `'Touch:<name>'` bindings, stacked bottom-right.
- `auto?: boolean` (default `true`): show the controls only on devices with `(pointer: coarse)`.

Members: `root`, `show(visible = true)`, `dispose()`.

```ts
scope.add(new TouchControls(app, controls, { sticks: ['move', 'aim'], buttons: [{ name: 'fire', label: '●' }, { name: 'q', label: 'Q' }, { name: 'e', label: 'E' }] }));
```

### Keyboard, Pointer, isTyping

These are the lower-level devices. `Controls` creates them for you.

- `new Keyboard(target = window, ignoreWhileTyping = true)`
  - `down: Set<string>` holds the codes of keys that are currently pressed.
  - `axis(negative[], positive[])` returns -1, 0 or 1.
  - `consume(code)` is true once per physical press.
  - `dispose()`.
  - Keys are cleared when the window loses focus. Keydowns are ignored while an input, textarea, select or contenteditable element has focus.
- `new Pointer(element)`
  - `x` and `y` are in normalised device coordinates (-1..1, y up) over `element`. `inside` is `true` after the pointer moved over the element and `false` after it left.
  - `buttons: Set<number>`, `consume(button)`, `dispose()`.
  - It suppresses the context menu on `element`.
- `isTyping(event)` is `true` when the event target is a text field or contenteditable element.

Duel reads digit keys directly for its weapon bar:

```ts
for (let i = 1; i <= 9; i++) {
  if (!controls.keyboard.consume(`Digit${i}`) || hud.typing) continue;
  const weapon = world.catalog.filter(entry => entry.kind === 'weapons' && !entry.hidden)[i - 1];
  if (weapon) net.command({ type: 'weapon', id: weapon.id });
}
```

## Scene and rendering

`@gaime/core/three` is an optional set of Three.js helpers the example games use. Any renderer works: the client only receives plain-JSON worlds, and `Visual` descriptors are just data your renderer interprets.

### Stage

```ts
createStage(options: StageOptions): Stage
```

| Option | Default | Meaning |
| --- | --- | --- |
| `container` | required | The canvas is appended here and resized to it (`ResizeObserver`). |
| `background` | `'#101418'` | Scene background colour. |
| `fov` | `50` | Perspective camera field of view (near 0.1, far 500). |
| `maxPixelRatio` | `2` | Cap for `devicePixelRatio`. |
| `shadows` | `true` | Enables the PCF shadow map. |

The renderer uses antialiasing, sRGB output and ACES filmic tone mapping. `Stage` exposes the following:

- `renderer`, `scene`, `camera`, `canvas`.
- `onFrame(callback: (dt, now) => void)` registers a per-frame callback and returns an unsubscribe function. `dt` is in seconds, clamped to 0.1. The scene is rendered after all callbacks.
- `dispose()` stops the loop, disconnects the observer, frees the scene through `disposeOwned` (geometry and materials marked as shared, such as those cached by `ModelLibrary` and `createBar`, survive for the next stage after a hot reload), disposes the renderer and removes the canvas.

Other helpers:

- `disposeObject(root)` frees every geometry, material and texture in a subtree, shared ones too. For entities use `disposeOwned`.
- `pickGround(camera, ndcX, ndcY, height = 0)` returns the point `{ x, z }` on the plane `y = height` under the given screen coordinates, or `undefined`. Starter aims with `pickGround(this.stage.camera, pointer.x, pointer.y, 0.9)`.

### The scene class pattern

All three games put the view in a class. The class owns a stage, a `ServerClock`, an `Interpolator` and one `EntityLayer` per entity dictionary:

- `update(world)` runs on every received world. It stores the world, syncs the clock, pushes interpolation samples, syncs the layers and reconciles the prediction.
- A per-frame callback (`stage.onFrame`) positions objects at the interpolated render time and moves the camera.
- `dispose()` disposes the layers and the stage.

### Interpolating remote entities

Patches arrive at about 15 Hz with network jitter. Rendering the latest position makes entities jump. Instead, render every remote entity slightly in the past, between two known samples.

```ts
new ServerClock()
  sync(serverTime: number, localMs = performance.now())   // call on every world with world.time
  now(delay = 0.1, localMs = performance.now()): number    // estimated server time minus `delay` s (0 before the first sync)

new Interpolator(angles: string[] = ['angle'], keep = 12)
  push(id, t, values: Record<string, number>)             // one sample per entity per world
  sample(id, t): Record<string, number> | undefined        // linear interpolation, clamped to the first and last sample
  retain(ids: Iterable<string>)                            // forget entities that no longer exist
```

`ServerClock` maps `world.time`, which only advances while the game is not paused, onto `performance.now()`. It keeps the fastest delivery seen as the estimate, drifts slowly towards later deliveries and snaps when the offset changes by more than 1 s. Fields listed in `angles` interpolate along the shortest arc. When time goes backwards for an entity (for example after a world reset), its track restarts. `sample` never extrapolates.

Render at `clock.now(0.1)`. That is a 100 ms buffer: at 15 Hz there are always about 1.5 patch intervals of samples ahead of the render time, so moderate jitter is absorbed.

```ts
// games/starter/src/client/scene.ts
update(world: World) {
  this.world = world;
  this.clock.sync(world.time);
  for (const player of Object.values(world.players)) this.tracks.push(player.id, world.time, { x: player.x, z: player.z, angle: player.angle });
  for (const enemy of Object.values(world.enemies)) this.tracks.push(enemy.id, world.time, { x: enemy.x, z: enemy.z, angle: enemy.angle });
  this.tracks.retain([...Object.keys(world.players), ...Object.keys(world.enemies)]);
  this.players.sync(Object.values(world.players).filter(player => player.online));
  this.enemies.sync(Object.values(world.enemies));
  this.effects.sync(world.effects);
  // … own-player reconciliation, below
}

private frame(dt: number) {
  const renderTime = this.clock.now(0.1);
  this.enemies.forEach((object, enemy) => {
    const sample = this.tracks.sample(enemy.id, renderTime) ?? enemy;
    object.position.set(sample.x, 0, sample.z);
    object.getObjectByName('body')!.rotation.y = sample.angle;
  });
  // …
  this.effects.update(renderTime);
}
```

Use the same render time for everything that is time-based: entities, effects (`effects.update(renderTime)`) and anything computed from `world.time`. This keeps them consistent with each other.

### Predicting your own player

Your own character must react instantly, so it is not interpolated. The client runs **the same movement function as the server** on a local copy of its position. The function lives in `src/shared/rules.ts`, which both the server and the client import:

```ts
// games/starter/src/shared/rules.ts
/** Player movement; the client runs the same function to predict its own character. */
export function movePlayer(player: { x: number; z: number; angle: number }, input: Input, dt: number) {
  moveTopDown(player, input, RULES.playerSpeed, dt);
  clampToArena(player);
  const dx = input.ax - player.x;
  const dz = input.az - player.z;
  if (Math.hypot(dx, dz) > 0.2) player.angle = Math.atan2(dx, dz);
}
```

Each frame, the local copy advances with the current input. On every world it is **softly reconciled** towards the authoritative position: it snaps when it is far off and otherwise drifts back gently.

```ts
// games/starter/src/client/scene.ts — in update(world)
const me = world.players[this.localId];
if (me && !me.respawnAt) {
  if (!this.local || dist(this.local, me) > 2.5) this.local = { x: me.x, z: me.z, angle: me.angle };
  else {
    // Soft reconciliation: gentle while moving (the server lags behind), firm when standing.
    const moving = !!this.input && (this.input.mx !== 0 || this.input.mz !== 0);
    const k = moving ? 0.06 : 0.3;
    this.local.x += (me.x - this.local.x) * k;
    this.local.z += (me.z - this.local.z) * k;
  }
} else this.local = undefined;

// in frame(dt)
if (this.local && this.input) movePlayer(this.local, this.input, world.pause ? 0 : dt);
this.players.forEach((object, player) => {
  const sample = player.id === this.localId && this.local ? this.local : this.tracks.sample(player.id, renderTime) ?? player;
  object.position.set(sample.x, 0, sample.z);
});
this.rig.update(this.local ?? world.players[this.localId] ?? { x: 0, z: 0 }, dt);
```

Blank does the same thing more simply: it snaps beyond 2 units and otherwise uses a fixed factor of 0.1. Notes on the design:

- The server state is always behind by about half a round trip, and while moving the predicted position is ahead of it. A small factor while moving avoids pulling the character backwards. A larger factor when standing still settles the remaining error quickly.
- `this.local` is a separate object. The received `me` is never modified.
- Set `scene.input` to `undefined` while disconnected (`net.connected ? input : undefined`), so the prediction does not run away from a server that receives nothing.
- Stop predicting when the server says the character cannot move (starter: `respawnAt`; `world.pause` sets `dt` to 0).
- Anything else that you control directly can be predicted the same way. Duel predicts only the barrel angle (`localAim`) during your turn and falls back to the server's `aim` otherwise.

### Side views

The simulation can use any axes. The renderer decides how they map into the scene. Duel simulates on `x` (right) and `z` (height) and draws a side view with one mapping function:

```ts
// games/duel/src/client/scene.ts
/** Side view: simulation x → scene X, simulation z (height) → scene Y. */
const at = (x: number, z: number, y = 0) => new THREE.Vector3(x, z + y, 0.5);

this.rig = new CameraRig(this.stage.camera, { offset: CAMERA.side, lookOffset: { x: 0, y: 5, z: 0 }, damping: 3 });
this.effects = new EffectsLayer(scene, { project: (x, z, y) => at(x, z, y) });

// in frame(dt): interpolated positions go through the same mapping
const sample = this.tracks.sample(player.id, time) ?? player;
object.position.copy(at(sample.x, sample.z)).setZ(0);
```

Duel's camera frames both fighters and every shell in flight. It widens the offset with the bounding box of all points:

```ts
const box = new THREE.Box3().setFromPoints(points);
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
this.rig.setOffset({ x: 0, y: 3, z: Math.max(24, size.x * 0.75 + 12, size.y * 1.4 + 12) });
this.rig.update({ x: center.x, z: 0, y: center.y }, dt);
```

The built-in `pulse` and `spawn` effects are rings lying in the horizontal plane. In a side view you see them edge-on, so prefer `hit`, `explosion`, `tracer` and `text`, or register your own renderers.

### EntityLayer

```ts
new EntityLayer<T extends { id: string }>(parent: THREE.Object3D, create: (entity: T) => THREE.Object3D, key: (entity: T) => string = () => '')
```

`EntityLayer` keeps one `Object3D` per entity id in sync with a dictionary from the world:

- `sync(entities)` creates objects for new ids and removes objects whose ids are missing. When `key(entity)` differs from the key the object was built with, it rebuilds the object.
- Removed objects are freed with `disposeOwned`.
- `forEach((object, entity) => …)` iterates with the latest entity.
- `group` is the layer's `THREE.Group`, and `items` maps each id to `{ object, key, entity }`.
- `dispose()` removes everything.

Put everything that changes how the object must be *built* into the key (colour, name, visual). Leave out what only changes how it is *placed* (position, hp).

```ts
// games/blank/src/client/scene.ts
this.players = new EntityLayer<Player>(scene, player => {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.8, 6, 16), new THREE.MeshStandardMaterial({ color: player.color }));
  body.position.y = 0.8;
  body.castShadow = true;
  const label = createLabel(player.name, { background: 'rgba(0,0,0,0.45)' });
  label.position.y = 2.1;
  root.add(body, label);
  return root;
}, player => `${player.color}:${player.name}`);
```

`disposeOwned(root)` disposes geometries unless a mesh has `userData.sharedGeometry`, and disposes materials and their textures unless it has `userData.sharedMaterial`. Mark anything you share between entities, or removing one entity breaks the others.

### Labels and bars

| Function | Description |
| --- | --- |
| `createLabel(text, { color = '#ffffff', size = 0.45, background? })` | A camera-facing `THREE.Sprite` with canvas text. Its height is `size` world units, `depthTest` is off and `renderOrder` is 10. |
| `setLabel(sprite, text)` | Redraws only when the text changed, so it is safe to call every frame. |
| `createBar(width, color, background = '#000000')` | A health or progress bar (`Bar`, a `THREE.Group`). |
| `setBar(bar, value, color?)` | `value` is 0..1. It fills from the left. |
| `faceCamera(object, camera)` | Orients a bar (or any group) towards the camera and compensates for the parent's rotation. Call it every frame. |

```ts
// games/starter/src/client/scene.ts — per frame
setLabel(object.getObjectByName('label') as THREE.Sprite, `${world.hostId === player.id ? '👑 ' : ''}${player.data['gaime-bot'] ? '🤖 ' : ''}${player.name}`);
const bar = object.getObjectByName('bar') as Bar;
setBar(bar, player.hp / player.maxHp);
faceCamera(bar, camera);
```

## Models

The server describes how an entity looks with a serialisable `Visual`:

```ts
interface Visual {
  shape: string;
  color?: string;
  emissive?: string;
  scale?: number | [number, number, number];   // purely visual
  lift?: number;                                // world units above the ground
}
```

`ModelLibrary` turns a `Visual` into a Three.js object:

| Member | Description |
| --- | --- |
| `build(visual)` | Returns a `THREE.Group` with one child named `'body'`, which has `scale` and `lift` applied. Rotate `'body'` to turn the model and keep bars or labels on the group. |
| `register(shape, factory: ModelFactory)` | A custom shape. `ModelFactory = (visual: Visual) => THREE.Object3D`, about 1 unit tall and standing on y = 0. |
| `load(shape, url, { height = 1, rotateY = 0, tint = false }): Promise<void>` | Registers a glTF or GLB file as a shape. The file comes from `public/`, for example `'/models/tree.glb'`. |
| `has(shape)` | `true` for built-in and registered shapes. |

Built-in primitive shapes are all about 1 unit tall and standing on y = 0: `box`, `sphere`, `capsule`, `cone`, `cylinder`, `torus`, `octahedron`, `ring`. They use a `MeshStandardMaterial` with `color` (default `#cccccc`) and `emissive` (intensity 0.8 when set), and their geometry is shared (`userData.sharedGeometry`). An unknown shape logs a warning and draws a box. A factory that throws also falls back to a box, so a broken model never breaks the scene.

```ts
// games/blank/src/client/scene.ts — look up the visual in the catalog, build it
this.pickups = new EntityLayer<Pickup>(scene, pickup => {
  const entry = this.world?.catalog.find(e => e.kind === 'pickups' && e.id === pickup.kind);
  return this.models.build((entry?.visual as Visual | undefined) ?? { shape: 'sphere', color: '#ffffff' });
}, pickup => pickup.kind);
```

### Feature models

A feature can ship its own shapes in `src/features/<id>/client.ts`. The file is browser-only and is never loaded by the server. `createFeatureModules(modules)` takes the result of an eager `import.meta.glob` and returns every module's default export plus `id` (the directory name), sorted by path. Modules without a default export are skipped with a warning. The fields a feature may export are up to the game (the core type `ClientFeature` is just `object`):

```ts
// games/starter/src/client/features.ts
export interface ClientFeature {
  /** Custom shapes: `visual.shape` name → factory building a Three.js object ~1 unit tall. */
  models?: Record<string, ModelFactory>;
}

const modules = import.meta.glob<{ default: ClientFeature }>('../features/*/client.ts', { eager: true });

export function createModels() {
  const library = new ModelLibrary();
  for (const feature of createFeatureModules(modules)) {
    for (const [shape, factory] of Object.entries(feature.models ?? {})) library.register(shape, factory);
  }
  return library;
}
```

```ts
// games/starter/src/features/crystal-golem/client.ts (shortened)
export default {
  models: {
    golem(visual) {
      const stone = new THREE.MeshStandardMaterial({ color: visual.color ?? '#8f7bff', roughness: 0.9, flatShading: true });
      const golem = new THREE.Group();
      const body = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55), stone);
      body.position.y = 0.75;
      golem.add(body);
      golem.traverse(object => { object.castShadow = true; });
      return golem;
    },
  },
} satisfies ClientFeature;
```

The server side then only sets `visual: { shape: 'golem', color: '#8f7bff' }`.

### glTF

`load()` needs to finish before you build entities with that shape, so await it before the first world is drawn. It normalises the model: centred on x/z, standing on y = 0, `height` units tall, rotated by `rotateY`. Every build clones the model with `SkeletonUtils.clone`, so skinned meshes work. Geometry and materials are shared with the cache and marked as shared. With `tint: true` and a `visual.color`, each build gets a private material copy with that colour.

```ts
const models = new ModelLibrary();
await models.load('tree', '/models/tree.glb', { height: 3 });
await models.load('mech', '/models/mech.glb', { height: 2, rotateY: Math.PI, tint: true });
```

`loadGltf(url): Promise<THREE.Object3D>` loads a file once per URL and caches the promise. Clone the result before adding it to a scene.

## Effects

Short-lived visuals (tracers, hits, explosions, floating numbers) are an array of immutable `Effect` objects in the world. The server adds them with `addEffect` from `@gaime/core/kit` (see [KIT.md](KIT.md)) and declares the array as a stream (`network.streams: ['feed', 'effects']`). The client draws them with `EffectsLayer`:

```ts
// server (games/duel/src/server/simulation.ts)
addEffect(world.effects, ctx.nextId(), 'explosion', world.time, at, { radius, color: '#ff8a3d' });
addEffect(world.effects, ctx.nextId(), 'text', world.time, player, { text: `-${hit}`, color: '#ff5977', y: 3 });

// client
this.effects = new EffectsLayer(scene);
// in update(world):
this.effects.sync(world.effects);
// in frame(dt):
this.effects.update(this.clock.now(0.1));
```

`Effect` is `{ id: number; type; time; x; z; y?; x2?; z2?; radius?; color?; text? }`. An effect becomes visible when the render time reaches `effect.time` and is removed after its renderer's `life`. Because effects are timestamped in server time and played at the interpolated render time, they line up with the interpolated entities. An effect is played once per id. Unknown types log one warning per type and are skipped. Effects more than 2 s in the future are dropped.

`builtinEffects(project)` returns the built-in renderers:

| Type | Life (s) | Default `y` | Look |
| --- | --- | --- | --- |
| `tracer` | 0.12 | 0.95 | line from (`x`, `z`) to (`x2`, `z2`), fading |
| `pulse` | 0.45 | 0.05 | horizontal ring growing to `radius` (default 1) |
| `spawn` | 0.7 | 0.05 | horizontal ring shrinking from 2 × `radius` |
| `hit` | 0.35 | 0.8 | sphere growing from 0.6 × `radius` (default 1) |
| `explosion` | 0.6 | 0.5 | coloured shell (default `#ff8a3d`) plus a bright core, `radius` default 2 |
| `text` | 1.1 | 2 | floating label with `text`, rising 1.5 units |

`color` defaults to white except for `explosion`. Every type fades out.

`new EffectsLayer(parent, options?)` takes these options:

- `renderers?: Record<string, EffectRenderer>`: extra renderers, or replacements for built-in types.
- `project?(x, z, y): THREE.Vector3`: maps simulation coordinates to the scene. The default is `(x, z, y) → (x, y, z)`, which is top-down on x/z. Pass it for side views (see [Side views](#side-views)).

Members: `group`, `sync(effects)`, `update(renderTime)`, `dispose()`.

A custom renderer:

```ts
import * as THREE from 'three';
import { EffectsLayer, type EffectRenderer } from '@gaime/core/three';

const shockwave: EffectRenderer = {
  life: 0.5,
  create: effect => {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: effect.color ?? '#59e3ff', transparent: true }));
    mesh.position.set(effect.x, effect.y ?? 0.1, effect.z);
    return mesh;
  },
  // k = age / life, 0..1
  animate: (object, effect, k) => {
    object.scale.setScalar((effect.radius ?? 3) * k);
    ((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - k;
  },
};

const effects = new EffectsLayer(stage.scene, { renderers: { shockwave } });
```

The server can then emit `addEffect(world.effects, ctx.nextId(), 'shockwave', world.time, at, { radius: 4 })`. Objects are freed with `disposeOwned` when they expire.

## Camera

```ts
new CameraRig(camera: THREE.PerspectiveCamera, options?: CameraRigOptions)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `offset` | `CAMERA.topDown` | Camera position relative to the target. |
| `lookOffset` | `(0, 0, 0)` | The point looked at, relative to the target. |
| `damping` | `6` | Follow stiffness (higher is snappier). It is frame-rate independent. |
| `bounds` | — | `{ minX, maxX, minZ, maxZ }` that the focus point is clamped to. |

Members:

- `update(target: { x, y?, z }, dt)`: call every frame. The first call snaps to the target.
- `shake(amount = 0.4)`: adds trauma in 0..1. It accumulates, is capped at 1 and decays at 2 per second, so a full shake lasts about 0.5 s.
- `setOffset(offset)`.
- `focus`: the smoothed point (`THREE.Vector3`).
- `camera`.

`CAMERA` presets (use them as `offset`):

| Preset | Offset | Use |
| --- | --- | --- |
| `topDown` | `(0, 22, 16)` | angled top-down: arena, twin-stick, tower defense |
| `overhead` | `(0, 30, 6)` | almost vertical: RTS, board games |
| `chase` | `(0, 6, -10)` | behind and above. Rotating it to follow an aim direction is up to the game. |
| `side` | `(0, 4, 38)` | side view for games simulated on x (right) and z (up) |

```ts
this.rig = new CameraRig(this.stage.camera, { offset: CAMERA.topDown });
// frame: follow the predicted player
this.rig.update(this.local ?? world.players[this.localId] ?? { x: 0, z: 0 }, dt);
// main.ts: shake on a server event
if (kind === 'down') { arena.rig.shake(0.5); controls.rumble(0.8, 200); }
```

## Audio

`SoundBank` is an optional default; any Web Audio code or library works with `net.on('event')`.

```ts
new SoundBank(options: SoundBankOptions)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `sounds` | required | `Record<string, SoundDefinition>`: synthesised tones or files. |
| `music` | — | `{ url, volume? }`, a looping track (default volume 0.3). |
| `volume` | `1` | Master volume, 0..1. |
| `storageKey` | `'gaime:muted'` | `localStorage` key for the mute switch. |

Sound definitions:

- `tones(list: Array<[frequency, seconds]>, wave: OscillatorType = 'triangle', volume = 0.08)`: a synthesised sequence with no files needed. Each tone starts after 80 % of the previous one and fades out exponentially.
- `{ url: '/audio/boom.mp3', volume?: number }`: a file from `public/` (default volume 1). It is fetched and decoded on first play, or up front with `preload()`.

| Member | Description |
| --- | --- |
| `play(name, { volume?, rate? })` | `rate` is the playback rate for files and a frequency multiplier for tones. Unknown names log a warning. Does nothing while muted. |
| `preload()` | Decode all file sounds now. |
| `music(play = true)` | Start or stop the music loop. If no audio context exists yet, the music starts on the first user gesture. |
| `toggleMute(): boolean` | Toggles mute, remembers it in `localStorage` and returns the new state. |
| `muted` | The current mute state. |
| `setVolume(volume)` | Master volume, clamped to 0..1. |
| `dispose()` | Removes the listeners, stops the music and closes the audio context. |

Browsers allow audio only after a user gesture. The bank listens for the first `pointerdown` or `keydown` on the window, then creates or resumes its `AudioContext` and starts music that was requested earlier. Sounds played before that are not heard.

```ts
// games/duel/src/client/main.ts
const sounds = scope.add(new SoundBank({
  sounds: {
    fire: tones([[180, 0.08], [120, 0.12]], 'square', 0.06),
    boom: tones([[90, 0.25], [60, 0.35]], 'sawtooth', 0.08),
    start: tones([[440, 0.1], [660, 0.16]]),
    win: tones([[523, 0.12], [659, 0.12], [784, 0.25]]),
  },
}));
scope.add(net.on('event', (name, data) => {
  if (name !== 'sound') return;
  sounds.play((data as { kind: string }).kind);
}));
```

On the server this is `ctx.emit('sound', { kind: 'boom' })` (see [SERVER.md](SERVER.md)).

## Hot reload rules

In dev, and in the supervisor's live mode, saving a client file replaces the code without reloading the page or dropping the connection. The pattern in `games/blank/src/client/main.ts` and `games/starter/src/client/main.ts` has five parts, and each one is required.

```ts
const scope = new Scope();                                                                        // 1
const net = keep(import.meta.hot, 'net', () => new GameClient<World, Input, Command>({ game: 'starter' }));  // 2
net.off();                                                                                        // 3
// … everything created or subscribed goes through scope.add / scope.listen …
if (net.world) { arena.localId = net.id; arena.update(net.world); hud.render(net.world); }        // 4

// Must be the literal `import.meta.hot.accept()` — Vite detects HMR boundaries statically.
if (import.meta.hot) {
  import.meta.hot.accept();                                                                       // 5
  import.meta.hot.dispose(() => scope.dispose());
}
```

1. **`Scope`** collects every cleanup of this module instance. When the module is replaced, `scope.dispose()` tears everything down in one call, in reverse order. An error in one cleanup is logged and does not stop the others. What it removes:
   - canvas and HUD DOM (`scope.add(() => surface.remove())`);
   - the stage and its animation loop (`scope.add(new Scene(...))`, via `dispose()`);
   - GPU resources;
   - frame callbacks (`scope.add(stage.onFrame(...))`);
   - client subscriptions (`scope.add(net.on(...))`);
   - window listeners (`scope.listen(window, 'keydown', …)`);
   - timers (`scope.interval`, `scope.timeout`);
   - the audio context.

   Without it, every save adds another canvas, another render loop and another set of key handlers.
2. **`keep(import.meta.hot, 'net', create)`** stores the `GameClient` in `import.meta.hot.data`, which survives module replacement. The new module instance gets the *same* connection, with its identity, room, latest world and pending reconnection. Creating a new client on every save would open a second WebSocket with the same ticket. The server would then replace the old session (`replaced`) and the player would briefly leave and rejoin. Outside dev (`import.meta.hot` undefined) `keep` simply calls `create()`.
3. **`net.off()`** removes every listener that the previous module instance registered on the kept client. Those listeners are closures over the disposed scene and HUD. Subscriptions made through `scope.add(net.on(...))` are already removed by `scope.dispose()`. `off()` is the safety net for anything subscribed without the scope, and it guarantees that the new module starts from zero listeners.
4. **`if (net.world) …`** redraws immediately from the kept state. The kept client is already connected, so no new `welcome` arrives. Without this line the new scene would not know your player id (`meId`/`localId`) until the next reconnect, and prediction and camera follow would not work. `GameUi` does the same thing internally: it renders `client.world` if there is one instead of showing the lobby.
5. **`import.meta.hot.accept()` must appear literally.** Vite finds HMR boundaries by statically scanning the source for `import.meta.hot.accept(`. An alias (`const hot = import.meta.hot; hot.accept()`) or a helper function is not detected. The module is then not self-accepting, and every change becomes a full page reload. Because `main.ts` accepts itself, an edit to any module it imports (`scene.ts`, `hud.ts`, `features.ts`, feature `client.ts` files, `shared/rules.ts`) re-executes `main.ts` with the new code. **`import.meta.hot.dispose(() => scope.dispose())`** runs just before that, on the old instance.

`Scope` API: `add(fnOrDisposable)` returns its argument, so `const scene = scope.add(new Scene(surface))` works. `listen(target, type, listener, options?)`, `interval(callback, ms)`, `timeout(callback, ms)` and `dispose()` complete the API.

`keep<T>(hot, key, create): T` takes `hot` as `{ data: Record<string, unknown> } | undefined`.

What is not carried over: state inside the old scene. Interpolation buffers, the predicted position, the camera focus, the charge of a shot and similar values start fresh. They rebuild within a patch or two. CSS files swap by themselves. Server code reloads independently (see [ARCHITECTURE.md](ARCHITECTURE.md#hot-reload)). After a server hot reload the client receives a new `welcome` on the same connection.

Production builds use `watchVersion` instead (see [watchVersion](#watchversion)).

## Performance tips

- **Write the DOM only when needed.** The HUD is re-rendered on every patch. Use `Writer.text` and `Writer.html` (as both example HUDs do), or compare before assigning.
- **Keep `EntityLayer` keys stable.** A key that changes on every patch (for example, one that includes hp or position) rebuilds the object 15 times per second. Put only build-relevant data in the key.
- **Share geometry and materials** between entities of the same kind, and mark them with `userData.sharedGeometry` and `userData.sharedMaterial` so `disposeOwned` leaves them alone. The built-in primitives already do this. Factories that allocate new geometry per build (like the golem) are fine for dozens of entities, not for thousands.
- **Call `Interpolator.retain`** with the current ids on every update, so tracks of entities that were removed are freed.
- **Cache object lookups** for large entity counts. `getObjectByName` walks the subtree. For many entities, store references in `object.userData` when you build the object.
- **Watch the renderer settings.** Lower `maxPixelRatio` (for example to 1.5) on heavy scenes. Disable `shadows` or reduce the shadow map size and the shadow camera bounds.
- **Call `net.input` once per frame.** The gate already throttles it, and calling it more often only costs JSON encoding.
- **Use custom effect renderers for many effects.** The built-in renderers allocate geometry per effect. For bullet storms, write a renderer that reuses shared geometry.
- **Measure** with F3 (patches/s, KB/s, resyncs, server tick and publish cost) and with `?lag=150&jitter=40&loss=5`. For server load, use `gaime load` ([reference/CLI.md](reference/CLI.md#load)).

## Common mistakes

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Wrapping or aliasing `import.meta.hot.accept()` | Every edit reloads the page. | Keep the literal call in `main.ts`. |
| `new GameClient(...)` without `keep` | Every edit reconnects, and the status flickers or ends in `replaced`. | `keep(import.meta.hot, 'net', …)` followed by `net.off()`. |
| Listeners, timers or `requestAnimationFrame` outside the `Scope` | Handlers fire twice after an edit, and render loops and canvases pile up. | `scope.add`, `scope.listen`, `scope.interval`, and `stage.onFrame` instead of your own loop. |
| No `if (net.world) …` after `keep` | After an edit the camera does not follow you and prediction stops. | Set `meId` from `net.id` and call `update(net.world)` once. |
| Mutating a received world (`me.x += …`, `world.feed.sort()`) | The view drifts from the server, and "impossible" values appear later. | Keep local state in your own objects and copy before sorting. |
| Drawing your own player from `sample()` | Movement feels delayed by the round trip plus 100 ms. | Predict it with the shared movement function and reconcile softly. |
| Rendering at `clock.now(0)` or with the latest patch | Remote entities stutter. | Render at `clock.now(0.1)`. |
| Different movement code on the client and the server | Your character rubber-bands. | Import one function from `src/shared/rules.ts` on both sides. |
| Sending `mz: move.y` with a top-down camera | W moves the character towards the camera. | Screen up is -z: `mz: -move.y`. |
| Game keys while chatting | Typing "wasd" in the chat moves the character. | Check `ui.typing` (or `isTyping(event)`) before using input. |
| Reading `controls.keyboard.consume(code)` for a key that is also bound in `actions` | The press is never seen. | `Controls.update()` consumes presses of bound keys. Use `pressed(action)` for those. |
| Reading `controls` before `update()` | `pressed()` is always false. | Call `controls.update()` first in the frame callback. |
| Player text in `Banner.set` or `Dialog.setContent` unescaped | Names break the HUD (HTML injection). | Wrap it in `escapeHtml(...)`. |
| `--g-*` overrides in `:root` in a stylesheet imported before `@gaime/core/ui` | The theme does not apply. | Import `@gaime/core/ui` first, then `./style.css` (as the example games do). |
| Sharing a geometry between entities without `userData.sharedGeometry` | Other entities disappear or render broken after one is removed. | Mark shared resources. |
| Effects array not declared as a stream, or never pruned on the server | Effects replay, go missing or grow the patch size. | `network.streams: ['feed', 'effects']` and `pruneEffects` ([KIT.md](KIT.md)). |
| Awaiting `ModelLibrary.load` after entities were built | Those entities stay boxes until they are rebuilt. | Await `load()` before the first `update`, or include the shape's availability in the layer key. |
