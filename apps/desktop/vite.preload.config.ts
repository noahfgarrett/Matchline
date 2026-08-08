import { defineConfig } from 'vite';

/**
 * Preload build. A sandboxed preload (PRODUCT.md §16) cannot use ESM and can only
 * `require` a small allowlist, so the façade and the channel table have to be bundled
 * into one CommonJS file with `electron` left external.
 */
export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    // The renderer build owns dist/renderer; clearing dist here would delete it.
    emptyOutDir: false,
    // Development only, for the same reason as the renderer build: a shipped
    // map is the whole source, in an app that hands nothing out.
    sourcemap: mode !== 'production',
    minify: false,
    target: 'es2022',
    lib: {
      entry: 'preload/index.ts',
      formats: ['cjs'],
      fileName: (): string => 'preload.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
}));
