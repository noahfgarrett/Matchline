import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Renderer build. Output lands next to the compiled main process in dist/. */
export default defineConfig({
  root: 'renderer',
  // Relative asset URLs so the bundle works unchanged under the app:// scheme.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
});
