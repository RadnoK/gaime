import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** What the admin API needs from the live room (it changes identity on every hot reload). */
export interface AdminTarget {
  admin(action: string, args: Record<string, unknown>): unknown;
}

/**
 * Process-wide status shared across hot reloads. Vite re-evaluates the server
 * modules on every change, but Express handlers survive, so they must read a global.
 */
interface RuntimeStatus {
  room?: AdminTarget;
  game: string;
  /** Version of the code that is loaded right now. */
  loaded: string;
  error: string | null;
  /** Modules disabled by the live engine (module id → message). */
  disabled: Record<string, string>;
  startedAt: number;
}

const KEY = Symbol.for('gaime.runtime');
const store = globalThis as unknown as Record<symbol, RuntimeStatus | undefined>;

export function runtime(): RuntimeStatus {
  const status = store[KEY] ??= { game: '', loaded: 'LOCAL', error: null, disabled: {}, startedAt: Date.now() };
  status.disabled ??= {};
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

export function markLoaded(game: string) {
  const status = runtime();
  status.game = game;
  status.loaded = codeVersion();
  status.error = null;
}

export function markError(error: unknown) {
  runtime().error = error instanceof Error ? error.message : String(error);
}

export function setRoom(room: AdminTarget | undefined, owner?: AdminTarget) {
  const status = runtime();
  if (room || status.room === owner) status.room = room;
}

export function clearError() {
  runtime().error = null;
}

export const dataDir = () => resolve(process.env.GAIME_DATA_DIR || '.gaime/data');
