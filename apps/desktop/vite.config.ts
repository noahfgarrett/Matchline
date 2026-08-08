import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Renderer build. Output lands next to the compiled main process in dist/. */
export default defineConfig(({ mode }) => ({
  root: 'renderer',
  // Relative asset URLs so the bundle works unchanged under the app:// scheme.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    // Maps in development, where they are what makes a stack trace readable;
    // not in a shipped build, where they would add the whole renderer source to
    // an app whose selling point is that it hands nothing out.
    sourcemap: mode !== 'production',
  },
}));
