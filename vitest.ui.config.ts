import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Not mergeConfig: it concatenates `include`, which would drag the unit suite in.
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ['tests-ui/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
