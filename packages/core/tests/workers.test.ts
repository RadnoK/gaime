import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { workerPool } from '../src/server/workers';

const root = join(import.meta.dirname, 'fixtures');

describe('workerPool (inline mode, as in tests)', () => {
  test('runs typed tasks, reports errors and timeouts', async () => {
    const pool = workerPool<typeof import('./fixtures/src/workers/math').default>('math', { root, timeout: 200 });
    expect(await pool.run('sum', { values: [1, 2, 3] })).toBe(6);
    await expect(pool.run('fail', undefined as never)).rejects.toThrow('intentional failure');
    await expect(pool.run('slow', undefined as never)).rejects.toThrow(/timed out/);
    expect(pool.stats()).toMatchObject({ name: 'math', done: 1, failed: 2 });
    pool.close();
    await expect(pool.run('sum', { values: [] })).rejects.toThrow(/was closed/);
  });
});
