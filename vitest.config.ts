import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // I test leggono il contratto dai sorgenti, cosi' non serve compilare
      // il pacchetto condiviso prima di eseguirli.
      '@vidiemme/copilot-usage-contract': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
