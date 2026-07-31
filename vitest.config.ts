import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli.ts is process wiring, covered by the end-to-end smoke test.
      // harness.ts is test scaffolding rather than shipped code.
      exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/tools/harness.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      // Set just below current levels, so a real regression fails the run
      // without the thresholds needing an edit on every small change.
      thresholds: {
        statements: 95,
        lines: 95,
        functions: 95,
        branches: 85,
      },
    },
  },
});
