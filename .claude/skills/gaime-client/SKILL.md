---
name: gaime-client
description: Work on the browser side of a gaime game — HUD and menus (GameUi), 3D scene and models (Three.js, glTF), effects, camera, sounds, controls (keyboard, mouse, gamepad, touch) — without breaking client hot reload. Use for any visual, UI, audio or input change.
---

# Client work: UI, 3D, audio, controls

Files: `games/<game>/src/client/` — `main.ts` (wiring + HMR), `scene.ts` (Three.js), `hud.ts` (DOM), `style.css`, `features.ts` (custom models from modules). Framework pieces: `@gaime/core/client`, `@gaime/core/three`, `@gaime/core/ui`, `@gaime/core/audio`. Reference: `docs/CLIENT.md`.

## Hot reload rules (the page must survive edits)

- `main.ts` keeps the connection: `const net = keep(import.meta.hot, 'net', () => new GameClient({ game: '<name>' })); net.off();`
- Everything else is created through a `Scope` and torn down in `import.meta.hot.dispose(() => scope.dispose())`. Use `scope.add(x)` for objects with `dispose()`, `scope.add(net.on(...))` for listeners, `scope.listen(window, …)`, `scope.interval(…)`.
- Keep the literal `import.meta.hot.accept()` in `main.ts` (Vite detects it statically).
- Never mutate `net.world` or objects from it — patches share unchanged objects between snapshots.

## HUD

`new GameUi({ client: net, parent: app, title, description, help, roster: { detail, colorOf }, menu: [...], actions: {...}, onEnter })` gives: lobby, status + ping, ☰ menu (pause, leave + yours), roster, feed + chat (Enter, `/help`), toasts for server notices, a banner (`ui.banner.set(html)`, buttons with `data-action="name"` call `actions.name`), F3 network stats, `ui.dialog(title)` panels. Put game widgets into `ui.top` (top bar), `ui.center` (bottom centre), `ui.layer` (free overlay). Helpers: `h('div', { class, onclick }, ...children)`, `meter()`, `escapeHtml()` (always escape player-made text!), `Writer` (update DOM only on change — HUDs render ~15×/s). Theme: override `--g-*` CSS variables on `:root` in `style.css`, and import `@gaime/core/ui` before `./style.css` in `main.ts` so your overrides win.

## Scene

- `createStage({ container })` → renderer, scene, camera, `onFrame(dt)`, `dispose()`.
- `CameraRig(camera, { offset: CAMERA.topDown | overhead | side | chase })`, `rig.update(target, dt)`, `rig.shake(0.5)`.
- `EntityLayer<T>(scene, create, key)` per entity dictionary: `layer.sync(Object.values(world.enemies))` on each world, `layer.forEach((object, entity) => …)` each frame. The `key` rebuilds the object when it changes (e.g. visual).
- Smooth remote entities: `ServerClock.sync(world.time)` + `Interpolator.push(id, world.time, {x, z, angle})`, render at `clock.now()` (automatic buffer: one patch interval + measured jitter). Your own character: predict with the shared movement function from `src/shared/rules.ts`, reconcile softly (see `games/starter/src/client/scene.ts`).
- Models: `ModelLibrary.build(visual)` for descriptors from the catalog; custom shapes via `library.register(shape, visual => object)` (module `client.ts` → `models`), glTF via `await library.load('tree', '/models/tree.glb', { height: 2 })` (files in `games/<game>/public/`).
- Effects: `new EffectsLayer(scene, { project?, renderers? })`, `effects.sync(world.effects)`, `effects.update(clock.now())`. Built-in: tracer, pulse, hit, spawn, text, explosion; add your own `EffectRenderer`.
- Bars and labels: `createBar`/`setBar`/`faceCamera`, `createLabel`/`setLabel`.
- Dispose what you create (`layer.dispose()`, `stage.dispose()`); shared primitive geometries are marked and skipped automatically.

## Controls

```ts
const controls = scope.add(new Controls({
  element: surface,
  actions: { fire: ['Mouse0', 'Space', 'Pad:RT', 'Touch:fire'], dash: ['KeyQ', 'Pad:A', 'Touch:dash'] },
  axes: { move: WASD, aim: { stick: 'right', touch: 'aim' } },
}));
scope.add(new TouchControls(app, controls, { sticks: ['move', 'aim'], buttons: [{ name: 'fire', label: '●' }] }));
// each frame:
controls.update();
const move = controls.axis('move');          // x right, y up; a top-down camera looking -Z: mz = -move.y
if (controls.pressed('dash')) net.command({ type: 'cast', slot: 0 });
net.input({ mx: move.x, mz: -move.y, … });
```

Ignore game keys while `ui.typing` (chat focused). Aiming at the ground: `pickGround(camera, pointer.x, pointer.y)`.

## Audio

`new SoundBank({ sounds: { hit: tones([[440, 0.1]]), boom: { url: '/audio/boom.mp3' } }, music: { url: '/audio/theme.mp3', volume: 0.2 } })`, `sounds.play('hit')`, `sounds.music()`, `sounds.toggleMute()`. It unlocks on the first user gesture. Trigger from server events: `net.on('event', (name, data) => …)`.

## Verify

```sh
npm run check
npm run dev -- <game>                        # edit a file while playing: no reload, no duplicate canvas
```

In the browser: one canvas after several hot reloads, no console errors, works with `?player=2` in a second tab, and with `?lag=150&jitter=40` (interpolation still smooth).

## Pitfalls

- Creating a new Three.js object per frame (geometries, materials) → memory leak; create once, update.
- `innerHTML` with player names without `escapeHtml` → XSS between players.
- Anything in `main.ts` not registered in the `Scope` survives hot reloads twice → duplicated listeners/loops.
- Client code must not import server code (`src/server/*`, `features/*/server.ts`).

## Reference

`docs/CLIENT.md` (GameClient, Scope/keep, Controls, GameUi, Stage, CameraRig, ModelLibrary, EffectsLayer, SoundBank), `docs/COOKBOOK.md` (HUD widgets, dialogs, sounds, glTF, touch/gamepad), `docs/TROUBLESHOOTING.md#hot-reload-problems`.
