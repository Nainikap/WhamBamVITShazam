import path from 'node:path';
import { defineConfig } from 'vite';

/**
 * Electron Forge loads this config as CJS. `@vgpu/wgsl` is ESM-only, so the
 * plugin is imported inside the transform hook instead of at module load.
 */
function wgslPlugin() {
  return {
    name: 'wgsl',
    async transform(this: { addWatchFile(file: string): void }, source: string, id: string) {
      if (!id.endsWith('.wgsl')) return null;
      const { transformWgsl } = await import('@vgpu/wgsl/loader-vite');
      return transformWgsl({
        source,
        id,
        onDependency: (absPath) => this.addWatchFile(absPath),
      });
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [wgslPlugin()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
