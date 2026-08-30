export default {
  test: {
    include: ['tests/**/*.integration.test.ts'],
    // Real Git packing is consistently fast locally but can cross 15 seconds
    // on Windows runners while antivirus scans newly created loose objects.
    testTimeout: 30_000,
    // These drive real Git repositories, file watchers, and media on disk;
    // running them at once starves the watcher of its events.
    fileParallelism: false,
    server: { deps: { external: [/node:sqlite/] } },
  },
  ssr: { external: ['node:sqlite'] },
};
