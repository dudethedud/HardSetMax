import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The database tests share (and empty) the same test database tables.
    fileParallelism: false,
  },
});
