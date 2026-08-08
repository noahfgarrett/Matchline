import { defineConfig } from 'vite';

/**
 * Preload build. A sandboxed preload (PRODUCT.md §16) cannot use ESM and can only
 * `require` a small allowlist, so the façade and the channel table have to be bundled
 * into one CommonJS file with `electron` left external.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    // The renderer build owns dist/renderer; clearing dist here would delete it.
    emptyOutDir: false,
    sourcemap: true,
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
});
