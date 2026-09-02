import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const binaryDataModules = resolve(
  __dirname,
  'node_modules/@shinyoshiaki/binary-data/src/node_modules',
);

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    // @shinyoshiaki/binary-data publishes internal modules under a nested
    // node_modules directory and loads them with package-style imports.
    // Point Rollup at that published layout so werift stays self-contained in
    // the Electron main bundle.
    alias: [
      { find: /^internal\/(.*)$/, replacement: `${binaryDataModules}/internal/$1` },
      { find: /^lib\/(.*)$/, replacement: `${binaryDataModules}/lib/$1` },
      { find: /^types\/(.*)$/, replacement: `${binaryDataModules}/types/$1` },
    ],
  },
  build: {
    // node:sqlite is newer than Vite's built-in module list, so name it here.
    // ws loads its native accelerators inside try/catch blocks and falls back to
    // JavaScript when they are absent. Keeping them external preserves that
    // optional runtime behavior instead of Vite emitting a startup-time throw.
    rollupOptions: { external: ['node:sqlite', 'bufferutil', 'utf-8-validate'] },
  },
});
