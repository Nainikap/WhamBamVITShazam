# SnipSnap

SnipSnap is the VideoGit V1 desktop application: local-first semantic version control for
DaVinci Resolve timelines. It versions canonical timeline decisions with native Git while media
stays external.

## Run locally

```bash
mise exec -- npm install
mise exec -- npm start
```

The local `.mise.toml` pins Node 22.22.0 because Electron Forge 7 packaging is not reliable under
Node 26. Electron itself is pinned in `package.json` and downloaded by npm.

## Workflow

1. Import a Resolve `.otio` file or create the deterministic demo.
2. Edit a trim, preset, gain, caption, or track order.
3. Stage semantic decisions and commit them.
4. Create and check out branches, compare changes, and merge.
5. Resolve conflicts with base/ours/theirs; completion stays blocked while invalid.
6. Tag an approved commit or export immutable HEAD to OTIO.

Machine-local media URLs are kept in application sidecar state and restored on export. They and
the footage itself never enter the Git commit tree.

## Verify

```bash
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm test
mise exec -- npm run test:integration
mise exec -- npm run test:e2e
mise exec -- npm run package
```

See [`../docs/V1_IMPLEMENTATION_STATUS.md`](../docs/V1_IMPLEMENTATION_STATUS.md) for requirement
traceability and the remaining live-DaVinci validation gate.
