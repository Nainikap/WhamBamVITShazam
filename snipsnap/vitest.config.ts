export default {
  test: {
    exclude: ['**/node_modules/**', '**/*.integration.test.ts', 'tests/e2e/**'],
    server: { deps: { external: [/node:sqlite/] } },
  },
  ssr: { external: ['node:sqlite'] },
};
