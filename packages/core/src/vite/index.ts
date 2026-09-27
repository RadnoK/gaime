import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, PluginOption, UserConfig } from 'vite';
import { colyseus } from 'colyseus/vite';

export interface GaimeViteOptions {
  /** Server entry exporting `server = createGameServer(game)`. Default `/src/server/index.ts`. */
  serverEntry?: string;
  /** Files that glob feature modules; touched when a feature directory is added or removed. */
  registries?: string[];
  /** Feature modules pattern (relative to the game root). */
  features?: RegExp;
}

const coreSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Everything a gaime game needs from Vite:
 * - Colyseus in the dev server with server-side HMR (rooms keep their state),
 * - production build of client (`dist/client`) and server (`dist/server/server.mjs`),
 * - discovery of new `src/features/*` directories without restarting,
 * - batching of backend reloads while the live supervisor syncs a commit,
 * - public HMR over wss behind a reverse proxy (`GAIME_PUBLIC_URL`).
 *
 * Environment: GAIME_PORT, GAIME_PUBLIC_URL, GAIME_ALLOWED_HOSTS, GAIME_APPLYING_FILE, GAIME_VERSION.
 * The production server reads GAIME_PORT (then PORT) again at start; the build-time value is its default.
 */
export function gaime(options: GaimeViteOptions = {}): PluginOption[] {
  const port = Number(process.env.GAIME_PORT || 5173);
  const serverEntry = options.serverEntry ?? '/src/server/index.ts';
  const registries = options.registries ?? ['src/server/registry.ts'];
  const features = options.features ?? /[\\/]src[\\/]features[\\/][^\\/]+[\\/][^\\/]+\.ts$/;
  const applying = process.env.GAIME_APPLYING_FILE;
  // Simulated round trip for latency testing, also in dev (Colyseus reads COLYSEUS_LATENCY).
  if (process.env.GAIME_LATENCY_MS) process.env.COLYSEUS_LATENCY = process.env.GAIME_LATENCY_MS;
  const publicUrl = process.env.GAIME_PUBLIC_URL ? new URL(process.env.GAIME_PUBLIC_URL) : undefined;
  const allowedHosts = [
    ...(publicUrl ? [publicUrl.hostname] : []),
    ...(process.env.GAIME_ALLOWED_HOSTS ?? '').split(',').map(host => host.trim()).filter(Boolean),
  ];

  // The production entry is generated as `server.listen(<port>)`: pass an expression so the
  // built server reads GAIME_PORT / PORT when it starts; the build-time port is the default.
  const runtimePort = `Number(process.env.GAIME_PORT || process.env.PORT || ${port})` as unknown as number;
  const game = colyseus({ serverEntry, serveClient: false, port: runtimePort });
  // A live sync writes many files at once: reload the backend once, after the whole tree landed.
  for (const plugin of game) {
    const original = plugin.hotUpdate;
    if (typeof original !== 'function') continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    plugin.hotUpdate = function (this: unknown, update) {
      const context = this as { environment?: { name: string } };
      if (context.environment?.name !== 'colyseus' || !update.modules.length) return;
      clearTimeout(timer);
      const run = () => {
        if (applying && existsSync(applying)) { timer = setTimeout(run, 50); return; }
        void (original as (this: unknown, options: typeof update) => unknown).call(context, update);
      };
      timer = setTimeout(run, 120);
    };
  }

  const config: Plugin = {
    name: 'gaime:config',
    config(): UserConfig {
      return {
        resolve: {
          // Framework source is resolved from the tree being run (release or candidate),
          // never through a node_modules link that may point at an older tree. It also
          // keeps @gaime/core inside Vite so its server code hot-reloads with the game.
          alias: [
            { find: /^@gaime\/core$/, replacement: resolve(coreSrc, 'shared/index.ts') },
            { find: /^@gaime\/core\/(server|client|three|shared|worker|kit|ui|audio)$/, replacement: `${coreSrc}/$1/index.ts` },
          ],
        },
        define: {
          'import.meta.env.GAIME_VERSION': JSON.stringify(process.env.GAIME_VERSION || 'LOCAL'),
        },
        server: {
          port,
          strictPort: true,
          host: '0.0.0.0',
          allowedHosts: allowedHosts.length ? allowedHosts : undefined,
          // Behind the gateway / TLS proxy the HMR WebSocket goes through the public address.
          ws: publicUrl ? { protocol: publicUrl.protocol === 'https:' ? 'wss' : 'ws', host: publicUrl.hostname, clientPort: Number(publicUrl.port) || (publicUrl.protocol === 'https:' ? 443 : 80) } : undefined,
          // The live supervisor runs the game from inside .gaime/<game>/live, so deny only data, never the tree.
          fs: { deny: ['**/.env', '**/.env.*', '**/*.{crt,pem,key}', '**/.git/**', '**/.gaime/data/**', '**/checkpoint.json*', '**/snapshots/**', '**/host.json', '**/controls/**'] },
        },
        build: { sourcemap: true },
      };
    },
  };

  const discovery: Plugin = {
    name: 'gaime:feature-discovery',
    configureServer(server) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = (file: string) => {
        if (!features.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const registry of registries) server.watcher.emit('change', resolve(server.config.root, registry));
        }, 100);
      };
      server.watcher.on('add', changed).on('unlink', changed);
      server.httpServer?.once('close', () => { clearTimeout(timer); server.watcher.off('add', changed).off('unlink', changed); });
    },
  };

  // Worker threads load their TypeScript through the same dev environment as the game server.
  let root = process.cwd();
  const workers: Plugin = {
    name: 'gaime:workers',
    config(user) { root = resolve(user.root ?? process.cwd()); },
    configureServer(server) {
      (globalThis as Record<symbol, unknown>)[Symbol.for('gaime.vite.colyseus')] = server.environments.colyseus;
    },
    // Production: bundle src/workers/*.ts and the worker bootstrap next to server.mjs.
    configEnvironment(name, _config, env) {
      if (name !== 'colyseus' || env.command !== 'build') return;
      const dir = resolve(root, 'src/workers');
      const input: Record<string, string> = { 'gaime-worker': resolve(coreSrc, 'server/worker-bootstrap.mjs') };
      if (existsSync(dir)) for (const file of readdirSync(dir)) if (/^[a-z0-9][a-z0-9-]*\.ts$/.test(file)) input[`workers/${basename(file, '.ts')}`] = resolve(dir, file);
      return {
        build: {
          rollupOptions: {
            input,
            output: { entryFileNames: (chunk: { name: string }) => (chunk.name === 'server' ? 'server.mjs' : `${chunk.name}.mjs`) },
          },
        },
      };
    },
  };

  return [config, discovery, ...game, workers];
}
