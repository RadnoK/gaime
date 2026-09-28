import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineRoom, defineServer, isDevMode } from 'colyseus';
import { RedisDriver } from '@colyseus/redis-driver';
import { RedisPresence } from '@colyseus/redis-presence';
import type { BaseWorld, Health } from '../shared/types';
import type { GameDefinition } from './game';
import { createRoomClass, listRecordings } from './room';
import { adminToken, markLoaded, runtime } from './runtime';
import { createMatchmaker, HttpError } from './matchmaking';
import { stats } from './metrics';
import { closeStalePools, poolStats } from './workers';

export * from './game';
export { createRoomClass } from './room';
export { readCheckpoint, saveCheckpoint, checkpointPath } from './persistence';
export { runtime, codeVersion, adminToken } from './runtime';
export { normalizeCode, type RoomSummary, type RoomMetadata } from './matchmaking';
export { workerPool, WorkerPool, type PoolOptions, type PoolStats } from './workers';
export { testContext, testGame, type TestGameOptions } from './testing';
export { Engine, type EngineHost } from './engine';
export { replay, type ReplayOptions } from './replay';
export { worldHash, type Recording, type Segment, type Entry, type ReplayResult } from './recorder';

const warned = new Set<string>();
const warnOnce = (text: string) => { if (!warned.has(text)) { warned.add(text); console.warn(`[gaime] ${text}`); } };

/**
 * Horizontal scaling (matches mode, production builds): with `GAIME_REDIS_URL` every process shares
 * the room listing and talks to the others through Redis; `GAIME_PUBLIC_ADDRESS` (host[:port][/path])
 * is where clients reach this process's rooms. Connections are created once per process.
 */
function scaling(game: GameDefinition<any, any, any, any>) {
  const publicAddress = process.env.GAIME_PUBLIC_ADDRESS || undefined;
  const url = process.env.GAIME_REDIS_URL;
  const base = publicAddress ? { publicAddress } : {};
  if (!url) return base;
  if (isDevMode) { warnOnce('GAIME_REDIS_URL is used by production builds only (release mode); the dev server runs one process.'); return base; }
  if (game.rooms?.mode !== 'matches') { warnOnce('GAIME_REDIS_URL is ignored: a shared game runs its one room in one process.'); return base; }
  const key = Symbol.for('gaime.redis');
  const store = globalThis as unknown as Record<symbol, { presence: RedisPresence; driver: RedisDriver } | undefined>;
  const redis = store[key] ??= { presence: new RedisPresence(url), driver: new RedisDriver(url) };
  return { ...base, presence: redis.presence, driver: redis.driver };
}

/**
 * The server entry of a game: `export const server = createGameServer(game)`.
 *
 * Routes: `/health` (loaded version + error, used by the supervisor and clients),
 * `/gaime/room` (matchmaking: `GET` → a room id, `POST` → a seat reservation; docs/ROOMS.md),
 * `/gaime/stats` (tick/publish/worker costs), `/gaime/admin/*` (operator API for the `gaime` CLI,
 * token required, `?room=<id|code>` picks a room). In production builds it also serves `dist/client`.
 */
export function createGameServer<W extends BaseWorld, I>(game: GameDefinition<W, I, any, any>) {
  const rooms = game.rooms ?? { mode: 'shared' as const };
  if (rooms.mode === 'matches' && !(Number.isInteger(rooms.size) && rooms.size >= 1)) throw new Error(`rooms.size must be a whole number ≥ 1 (got ${rooms.size}).`);
  // Evaluated again on every hot reload: this is how the supervisor learns the new code is live.
  markLoaded(game.name, rooms);
  closeStalePools();
  // Simulated network round trip for latency testing (Colyseus reads COLYSEUS_LATENCY).
  if (process.env.GAIME_LATENCY_MS) process.env.COLYSEUS_LATENCY = process.env.GAIME_LATENCY_MS;
  const matchmaker = createMatchmaker(game.name);
  const processIndex = Number(process.env.GAIME_PROCESS_INDEX) || 0;
  if (rooms.mode === 'shared' && processIndex > 0) warnOnce(`Process ${processIndex}: a shared game runs in process 0 only — this one stays idle.`);
  const fail = (res: Response, error: unknown, status = 503) => {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (status === 503) { console.error('[gaime] room', error); res.status(503).set('Retry-After', '2').json({ error: 'Game temporarily unavailable.' }); return; }
    res.status(status).json({ error: (error as Error).message });
  };
  // Express handlers are registered once per process and outlive hot reloads: read live values from runtime().
  const idle = () => runtime().mode.mode === 'shared' && processIndex > 0;
  const localRooms = () => Object.values(runtime().rooms);

  return defineServer({
    rooms: { [game.name]: defineRoom(createRoomClass(game)) },
    ...scaling(game),
    express: async app => {
      const { default: express } = await import('express');
      app.get('/health', (_req: Request, res: Response) => {
        const status = runtime();
        const health: Health = {
          ok: !status.error, game: status.game, version: status.loaded, error: status.error,
          ...(Object.keys(status.disabled).length ? { disabled: status.disabled } : {}),
          uptime: Math.round((Date.now() - status.startedAt) / 1000),
        };
        res.set('Cache-Control', 'no-store').json({ ...health, rooms: localRooms().length });
      });
      app.get('/gaime/room', async (req: Request, res: Response) => {
        try {
          if (idle()) throw new HttpError(503, 'This process is idle (a shared game runs in process 0).');
          res.set('Cache-Control', 'no-store').json(await matchmaker.peek({ code: req.query.code, create: req.query.create }));
        } catch (error) { fail(res, error); }
      });
      app.post('/gaime/room', express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
        try {
          if (idle()) throw new HttpError(503, 'This process is idle (a shared game runs in process 0).');
          res.set('Cache-Control', 'no-store').json(await matchmaker.join((req.body ?? {}) as Record<string, unknown>));
        } catch (error) { fail(res, error); }
      });
      app.get('/gaime/stats', (_req: Request, res: Response) => {
        const matches = runtime().mode.mode === 'matches';
        const clients = localRooms().reduce((sum, room) => sum + room.clients.length, 0);
        res.set('Cache-Control', 'no-store').json({ ...stats(), ...(matches ? { clients } : {}), rooms: localRooms().length, workers: poolStats() });
      });

      const token = adminToken();
      const authorised = (req: Request, res: Response, next: NextFunction) => {
        const given = Buffer.from(String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
        const expected = Buffer.from(token);
        if (given.length === expected.length && timingSafeEqual(given, expected)) { next(); return; }
        res.status(401).json({ error: 'Missing or wrong admin token (GAIME_ADMIN_TOKEN / <data>/admin-token).' });
      };
      const admin = async (req: Request, res: Response) => {
        try {
          const action = String(req.params.action);
          const body = (req.body ?? {}) as Record<string, unknown>;
          const target = String(req.query.room ?? body.room ?? '') || undefined;
          // Process-wide actions need no room (the listing covers every room's recordings).
          const result = action === 'rooms' ? await matchmaker.list() : action === 'replays' ? listRecordings() : await matchmaker.admin(target, action, body);
          res.set('Cache-Control', 'no-store').json(result);
        } catch (error) { fail(res, error, 400); }
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
