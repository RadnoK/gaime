import { defineWorker } from '@gaime/core/worker';
import { RULES } from '../shared/rules';

type Point = { x: number; z: number };

/**
 * Runs in worker threads (see src/server/tactics.ts). Deliberately "heavy": a dense
 * threat field over the whole arena, recomputed from scratch for every request.
 */
export default defineWorker({
  threat(input: { enemies: Array<Point & { weight: number }>; resolution?: number }) {
    const size = Math.min(200, Math.max(10, input.resolution ?? 120));
    const cell = (RULES.arenaRadius * 2) / size;
    let hottest = { x: 0, z: 0, value: 0 };
    const sectors = [0, 0, 0, 0];
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const x = -RULES.arenaRadius + (i + 0.5) * cell;
        const z = -RULES.arenaRadius + (j + 0.5) * cell;
        if (x * x + z * z > RULES.arenaRadius ** 2) continue;
        let value = 0;
        for (const enemy of input.enemies) value += enemy.weight / (1 + (enemy.x - x) ** 2 + (enemy.z - z) ** 2);
        if (value > hottest.value) hottest = { x, z, value };
        sectors[(z < 0 ? 0 : 2) + (x < 0 ? 0 : 1)] += value;
      }
    }
    const names = ['north-west', 'north-east', 'south-west', 'south-east'];
    const worst = sectors.indexOf(Math.max(...sectors));
    return { hottest, sector: names[worst], cells: size * size };
  },
});
