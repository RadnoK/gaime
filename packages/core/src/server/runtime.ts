import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RoomsConfig } from './game';

/** What the admin API needs from a live room (rooms change identity on every hot reload). */
export interface AdminTarget {
  admin(action: string, args: Record<string, unknown>): unknown;
}

/** A live room of this process, as the HTTP handlers see it. */
export interface RoomTarget extends AdminTarget {
  readonly roomId: string;
  /** Invite code of a private match. */
  readonly code?: string;
  readonly clients: { length: number };
}

/**
 * Process-wide status shared across hot reloads. Vite re-evaluates the server
 * modules on every change, but Express handlers survive, so they must read a global.
 */
interface RuntimeStatus {
  /** The room that registered last (the shared room in `shared` mode). */
  room?: AdminTarget;
  /** Every live room of this process by id. */
  rooms: Record<string, RoomTarget>;
  /** `GameDefinition.rooms` of the code loaded right now. */
  mode: RoomsConfig;
  game: string;
  /** Version of the code that is loaded right now. */
  loaded: string;
  /** The first reported error (see `errors`), or null. */
  error: string | null;
  /** Errors that paused a room, by owner (room id); cleared by the owner or a code load. */
  errors: Record<string, string>;
  /** Modules disabled by a live engine (module id → message), until the next code load. */
  disabled: Record<string, string>;
  startedAt: number;
}

const KEY = Symbol.for('gaime.runtime');
const store = globalThis as unknown as Record<symbol, RuntimeStatus | undefined>;

export function runtime(): RuntimeStatus {
  const status = store[KEY] ??= { rooms: {}, mode: { mode: 'shared' }, game: '', loaded: 'LOCAL', error: null, errors: {}, disabled: {}, startedAt: Date.now() };
  status.disabled ??= {};
  status.errors ??= {};
  status.rooms ??= {};
  status.mode ??= { mode: 'shared' };
  return status;
}

/** `GAIME_VERSION_FILE` (written by the live supervisor) wins over `GAIME_VERSION`. */
export function codeVersion(): string {
  const file = process.env.GAIME_VERSION_FILE;
  if (file && existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  return process.env.GAIME_VERSION || 'LOCAL';
}

/** New code was evaluated: errors and switched-off modules belong to the old code. */
export function markLoaded(game: string, mode: RoomsConfig = { mode: 'shared' }) {
  const status = runtime();
  status.game = game;
  status.mode = mode;
  status.loaded = codeVersion();
  status.errors = {};
  status.error = null;
  status.disabled = {};
}

export function markError(error: unknown, owner = 'game') {
  const status = runtime();
  status.errors[owner] = error instanceof Error ? error.message : String(error);
  status.error = Object.values(status.errors)[0] ?? null;
}

export function clearError(owner = 'game') {
  const status = runtime();
  delete status.errors[owner];
  status.error = Object.values(status.errors)[0] ?? null;
}

/** A room started (`room`) or stopped (`undefined`, with `owner` = the room that stops). */
export function setRoom(room: RoomTarget | undefined, owner?: RoomTarget) {
  const status = runtime();
  if (room) { status.room = room; status.rooms[room.roomId] = room; return; }
  if (!owner) return;
  if (status.rooms[owner.roomId] === owner) delete status.rooms[owner.roomId];
  if (status.room === owner) status.room = Object.values(status.rooms).at(-1);
}

export const dataDir = () => resolve(process.env.GAIME_DATA_DIR || '.gaime/data');

/**
 * Token for `/gaime/admin/*`: GAIME_ADMIN_TOKEN, or a random one kept in the data directory.
 * Several processes may share the directory: the first one creates the file, the others read it.
 */
export function adminToken(): string {
  if (process.env.GAIME_ADMIN_TOKEN) return process.env.GAIME_ADMIN_TOKEN;
  const file = join(dataDir(), 'admin-token');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (existsSync(file)) {
      const token = readFileSync(file, 'utf8').trim();
      if (token) return token;
      // Another process is writing it right now.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString('hex');
    try { writeFileSync(file, token, { mode: 0o600, flag: 'wx' }); return token; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new Error(`${file} is empty — delete it and restart.`);
}

/** Room option that only the game server knows: rooms are never created through Colyseus' public matchmaking routes. */
export const CREATE_KEY = 'gaime-create';
export const createSecret = () => createHash('sha256').update(`gaime-create:${adminToken()}`).digest('hex').slice(0, 32);
