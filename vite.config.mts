import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: './src/renderer',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@backend': path.resolve(__dirname, './backend'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // Electron 40 ships Chromium 131+, so we can safely target modern ES.
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Split heavy vendor libs into dedicated chunks so the initial
        // renderer bundle stays small and chat/editor stay on the hot path.
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;

          if (
            id.includes('node_modules/react-error-boundary') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react/') ||
            id.match(/node_modules\/react(-dom)?$/)
          ) {
            return 'react-vendor';
          }

          if (
            id.includes('node_modules/@milkdown/') ||
            id.includes('node_modules/@monaco-editor/') ||
            id.includes('node_modules/marked/') ||
            id.includes('node_modules/dompurify/')
          ) {
            return 'editor-vendor';
          }

          if (
            id.includes('node_modules/react-force-graph') ||
            id.includes('node_modules/graphology') ||
            id.includes('node_modules/recharts')
          ) {
            return 'graph-vendor';
          }

          if (
            id.includes('node_modules/i18next') ||
            id.includes('node_modules/react-i18next')
          ) {
            return 'i18n-vendor';
          }

          if (id.includes('node_modules/lucide-react')) {
            return 'icons-vendor';
          }

          return undefined;
        },
      },
    },
  },
  // Fusion 3.9 — mark `console.log` / `info` / `debug` as side-effect-free
  // so esbuild's DCE eliminates them from the production bundle. The
  // renderer had ~270 console sites at the start of Phase 3; the audit's
  // concern was prod console pollution. Strip them surgically and keep
  // `console.warn` + `console.error` as diagnostic surface for support
  // triage. In `vite serve` (dev), `pure` is still applied but unminified
  // output keeps the calls visible — exactly what we want during dev.
  esbuild: {
    pure: ['console.log', 'console.info', 'console.debug'],
  },
  server: {
    port: 5173,
  },
});
