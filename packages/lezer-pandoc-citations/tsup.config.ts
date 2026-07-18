import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: '../../src/editor/lezer-extensions/pandoc-citations.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@lezer/markdown', '@lezer/highlight', '@lezer/common'],
});
