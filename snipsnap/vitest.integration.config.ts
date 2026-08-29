export default {
  test: {
    include: ['tests/**/*.integration.test.ts'],
    testTimeout: 15_000,
    // These drive real Git repositories, file watchers, and media on disk;
    // running them at once starves the watcher of its events.
    fileParallelism: false,
    server: { deps: { external: [/node:sqlite/] } },
  },
  ssr: { external: ['node:sqlite'] },
};
