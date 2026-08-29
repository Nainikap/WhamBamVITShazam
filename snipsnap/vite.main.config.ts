import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    // node:sqlite is newer than Vite's built-in module list, so name it here.
    rollupOptions: { external: ['node:sqlite'] },
  },
});
