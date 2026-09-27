import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const core = resolve(import.meta.dirname, 'packages/core/src');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@gaime\/core$/, replacement: `${core}/shared/index.ts` },
      { find: /^@gaime\/core\/(server|client|three|shared)$/, replacement: `${core}/$1/index.ts` },
    ],
  },
  test: {
    include: ['tests/**/*.test.{ts,mjs}', 'packages/*/tests/**/*.test.{ts,mjs}', 'games/*/tests/**/*.test.{ts,mjs}'],
    testTimeout: 20000,
  },
});
