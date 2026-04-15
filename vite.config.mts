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
    // Electron 28 ships Chromium 120, so we can safely target modern ES.
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
  server: {
    port: 5173,
  },
});
