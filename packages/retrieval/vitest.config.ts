import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // The integration suite needs Docker and has its own config.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
  },
});
