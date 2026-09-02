import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/signaling-server.ts',
    outDir: '.signaling',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'server.cjs',
      },
    },
  },
});
