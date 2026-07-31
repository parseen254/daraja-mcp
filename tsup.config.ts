import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
});
