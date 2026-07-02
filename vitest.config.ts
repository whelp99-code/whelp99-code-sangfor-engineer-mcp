import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sangfor/approval': fromRoot('./packages/sangfor-approval/src/index.ts'),
      '@sangfor/config-state': fromRoot('./packages/sangfor-config-state/src/index.ts'),
      '@sangfor/hci-client': fromRoot('./packages/sangfor-hci-client/src/index.ts'),
      '@sangfor/knowledge': fromRoot('./packages/sangfor-knowledge/src/index.ts'),
      '@sangfor/operator': fromRoot('./packages/sangfor-operator/src/index.ts'),
      '@sangfor/product-adapters': fromRoot('./packages/sangfor-product-adapters/src/index.ts'),
      '@sangfor/rag': fromRoot('./packages/sangfor-rag/src/index.ts'),
      '@sangfor/shared': fromRoot('./packages/shared/src/index.ts'),
      '@sangfor/wiki': fromRoot('./packages/sangfor-wiki/src/index.ts'),
      '@sangfor/pptx': fromRoot('./packages/sangfor-pptx/src/index.ts'),
      '@sangfor/screenshot': fromRoot('./packages/sangfor-screenshot/src/index.ts')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**']
  }
});
