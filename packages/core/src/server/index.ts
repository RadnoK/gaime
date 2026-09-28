import type { NextFunction, Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineRoom, defineServer, matchMaker } from 'colyseus';
import type { BaseWorld, Health } from '../shared/types';
import type { GameDefinition } from './game';
import { createRoomClass } from './room';
import { dataDir, markLoaded, runtime } from './runtime';
import { stats } from './metrics';
import { closeStalePools, poolStats } from './workers';

export * from './game';
export { createRoomClass } from './room';
export { readCheckpoint, saveCheckpoint, checkpointPath } from './persistence';
export { runtime, codeVersion } from './runtime';
export { workerPool, WorkerPool, type PoolOptions, type PoolStats } from './workers';
export { testContext, testGame, type TestGameOptions } from './testing';
export { Engine, type EngineHost } from './engine';

/** Token for `/gaime/admin/*`: GAIME_ADMIN_TOKEN, or a random one kept in the data directory. */
export function adminToken(): string {
  if (process.env.GAIME_ADMIN_TOKEN) return process.env.GAIME_ADMIN_TOKEN;
  const file = join(dataDir(), 'admin-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * The server entry of a game: `export const server = createGameServer(game)`.
 *
 * Routes: `/health` (loaded version + error, used by the supervisor and clients),
 * `/gaime/room` (id of the single shared room), `/gaime/stats` (tick/publish/worker costs),
 * `/gaime/admin/*` (operator API for the `gaime` CLI, token required).
 * In production builds it also serves `dist/client`.
 */
export function createGameServer<W extends BaseWorld, I>(game: GameDefinition<W, I, any, any>) {
  // Evaluated again on every hot reload: this is how the supervisor learns the new code is live.
  markLoaded(game.name);
  closeStalePools();
  // Simulated network round trip for latency testing (Colyseus reads COLYSEUS_LATENCY).
  if (process.env.GAIME_LATENCY_MS) process.env.COLYSEUS_LATENCY = process.env.GAIME_LATENCY_MS;
  let creating: Promise<string> | undefined;
  const roomId = async () => {
    const rooms = await matchMaker.query({ name: game.name });
    if (rooms[0]) return rooms[0].roomId;
    creating ??= matchMaker.createRoom(game.name, {}).then(room => room.roomId).finally(() => { creating = undefined; });
    return creating;
  };

  return defineServer({
    rooms: { [game.name]: defineRoom(createRoomClass(game)) },
    express: async app => {
      const { default: express } = await import('express');
      app.get('/health', (_req: Request, res: Response) => {
        const status = runtime();
        res.set('Cache-Control', 'no-store').json({
          ok: !status.error, game: status.game, version: status.loaded, error: status.error,
          ...(Object.keys(status.disabled).length ? { disabled: status.disabled } : {}),
          uptime: Math.round((Date.now() - status.startedAt) / 1000),
        } satisfies Health);
      });
      app.get('/gaime/room', async (_req: Request, res: Response) => {
        try { res.set('Cache-Control', 'no-store').json({ roomId: await roomId() }); }
        catch (error) { console.error('[gaime] room', error); res.status(503).set('Retry-After', '2').json({ error: 'Game temporarily unavailable.' }); }
      });
      app.get('/gaime/stats', (_req: Request, res: Response) => { res.set('Cache-Control', 'no-store').json({ ...stats(), workers: poolStats() }); });

      const token = adminToken();
      const authorised = (req: Request, res: Response, next: NextFunction) => {
        const given = Buffer.from(String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
        const expected = Buffer.from(token);
        if (given.length === expected.length && timingSafeEqual(given, expected)) { next(); return; }
        res.status(401).json({ error: 'Missing or wrong admin token (GAIME_ADMIN_TOKEN / <data>/admin-token).' });
      };
      const admin = async (req: Request, res: Response) => {
        try {
          // Express handlers outlive hot reloads: always ask the room that is live right now.
          await roomId();
          const room = runtime().room;
          if (!room) throw new Error('The game room is not running.');
          res.set('Cache-Control', 'no-store').json(await room.admin(String(req.params.action), (req.body ?? {}) as Record<string, unknown>));
        } catch (error) { res.status(400).json({ error: (error as Error).message }); }
      };
      app.get('/gaime/admin/:action', authorised, admin);
      app.post('/gaime/admin/:action', authorised, express.json({ limit: '256kb' }), admin);

      game.routes?.(app);
      if (import.meta.env.PROD) serveClient(app, express);
    },
  });
}

function serveClient(app: import('express').Application, express: typeof import('express')) {
  const root = resolve('dist/client');
  if (!existsSync(root)) return;
  app.get(['/', '/index.html'], (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').sendFile('index.html', { root, dotfiles: 'deny' });
  });
  // Hashed bundles never change under the same URL.
  app.use('/assets', express.static(resolve(root, 'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false }));
  app.use(express.static(root, { index: false, dotfiles: 'deny', maxAge: '5m' }));
}
