import { workerPool } from '@gaime/core/server';
import type { World } from '../shared/types';
import { registry } from './registry';

/** Worker pool for heavy analysis; see src/workers/tactics.ts. */
export const tactics = workerPool<typeof import('../workers/tactics').default>('tactics', { size: 2, timeout: 5000 });

export function threatInput(world: World) {
  return {
    enemies: Object.values(world.enemies).map(enemy => ({ x: enemy.x, z: enemy.z, weight: registry.kinds.enemies[enemy.kind]?.damage ?? 1 })),
  };
}
