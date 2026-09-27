import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './runtime';

export interface Checkpoint<W> {
  format: 1;
  game: string;
  savedAt: number;
  version: string;
  world: W;
  /** Private browser ticket → player id. Never sent to clients. */
  identities: Record<string, string>;
}

export const checkpointPath = () => join(dataDir(), 'checkpoint.json');

/** Throws on a corrupt or foreign checkpoint. The file is always left in place. */
export function readCheckpoint<W>(game: string): Checkpoint<W> | undefined {
  const path = checkpointPath();
  if (!existsSync(path)) return undefined;
  let data: Checkpoint<W>;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Corrupt checkpoint ${path}: ${(error as Error).message}. The file was kept — move it away to start over.`); }
  if (data?.format !== 1 || typeof data.world !== 'object' || !data.world || typeof data.identities !== 'object') {
    throw new Error(`Unknown checkpoint format in ${path}. The file was kept.`);
  }
  if (data.game && data.game !== game) throw new Error(`Checkpoint ${path} belongs to game "${data.game}", not "${game}".`);
  return data;
}

export function saveCheckpoint<W extends { version: string }>(game: string, world: W, identities: Record<string, string>, omit: string[] = []) {
  const path = checkpointPath();
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const stored = omit.length ? Object.fromEntries(Object.entries(world).filter(([key]) => !omit.includes(key))) : world;
  const data: Checkpoint<unknown> = { format: 1, game, savedAt: Date.now(), version: world.version, world: stored, identities };
  // Atomic rename: backups and the supervisor can copy the file at any moment.
  writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
