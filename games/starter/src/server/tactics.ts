import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerPool } from '@gaime/core/server';
import type { World } from '../shared/types';
import { registry } from './registry';

/**
 * Worker pool for heavy analysis; see src/workers/tactics.ts. `root` lets tests (run from the
 * repo root) find the worker when tasks run inline; the dev server and production ignore it.
 */
export const tactics = workerPool<typeof import('../workers/tactics').default>('tactics', { size: 2, timeout: 5000, root: resolve(dirname(fileURLToPath(import.meta.url)), '../..') });

export function threatInput(world: World) {
  return {
    enemies: Object.values(world.enemies).map(enemy => ({ x: enemy.x, z: enemy.z, weight: registry.kinds.enemies[enemy.kind]?.damage ?? 1 })),
  };
}
