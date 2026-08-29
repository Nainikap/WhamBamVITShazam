# VideoGit V1 implementation status

> Updated: 2026-08-29
>
> This is an evidence map, not a replacement for the authoritative
> [`VideoGit_Engineering_Plan.md`](./VideoGit_Engineering_Plan.md). The implementation is in
> `snipsnap/`.

## Current result

The local V1 architecture is implemented end to end:

```text
React/Zustand renderer
  -> typed context-isolated preload IPC
  -> Electron main
  -> ProjectService
  -> canonical model / OTIO / semantic diff / three-way merge / native Git
```

There is no Fastify server, media CAS, FFmpeg worker, SQLite queue, hosted auth, or cross-NLE
adapter in V1. Those remain V2 work as required by the Engineering Plan.

## Requirement traceability

| Engineering Plan requirement | Implementation | Automated evidence | Status |
|---|---|---|---|
| Stable IDs, integer half-open frame ranges, rational FPS, bounded fields, full relationship validation | `src/domain/` Zod schemas and frame helpers | `tests/domain.test.ts` | Automated |
| Deterministic NFC canonical JSON | `src/domain/canonical.ts` | key-order, Unicode, digest, and stable UUID property tests | Automated |
| Minimal Resolve OTIO cut subset | `src/adapters/otio/` imports/exports tracks, clips, gaps, timing, and SnipSnap caption metadata | `tests/otio.test.ts`, including parse by official OpenTimelineIO 0.18.1 when installed | Automated for OTIO; Resolve validation pending |
| Footage and machine-local paths never enter Git | canonical assets contain fingerprint/name/length; relink URLs live in untracked `media-links.json` application state | Git integration asserts the commit tree contains only `timeline.json` and its blob has no source path | Automated |
| Real Git commits, branches, refs, tags, merge-base, and two-parent commits | `src/git/` uses native Git plumbing through `spawn` argument arrays with `shell: false`; Git pack/delta maintenance compacts similar snapshots without changing their logical format | `tests/git.integration.test.ts` and `tests/application.integration.test.ts` inspect actual object types, parents, trees, refs, tags, compaction behavior, and `git fsck` | Automated |
| Compare-and-swap ref safety | immutable objects are created first; refs move last through `update-ref <new> <expected-old>` | stale-ref unit/integration cases, including a target moved during conflict resolution | Automated |
| Distinct HEAD / INDEX / WORKING snapshots | HEAD is read from a commit, semantic INDEX is the real Git index, WORKING is atomically persisted application state | selective-stage integration test proves a commit contains only one of two working edits | Automated |
| Semantic status and atomic staging | `src/diff/` emits stable-ID hunks for trims, ranges, fields, entities, and order; hunk IDs bind the base digest | diff/command unit tests cover selective staging, atomic trim/order, and stale hunk rejection | Automated |
| Typed validated edit commands | `src/commands/` implements trim, gain, preset, caption, reorder, and rename reducers | valid/invalid reducer tests | Automated |
| Conservative field-level three-way merge | `src/merge/` implements one-sided, same-value, different-field, same-field, delete/modify, order, and whole-project validation rules | unit/property tests cover independent edits, same-field choice, delete/modify restoration, incompatible order, and invalid combined timing | Automated |
| Persisted conflict resolution, validation gate, and safe abort | atomic merge-session files store immutable base/parent IDs and provisional state; complete uses target-ref CAS | application integration and Electron E2E conflict flow | Automated |
| Dirty checkout guard and restart safety | checkout requires clean state unless explicit discard; workspace/index/head validate after service restart | application integration tests | Automated |
| Compare, history, branches, tags, conflict resolver, and export UI | `src/renderer/` uses Zustand over the typed preload API | packaged Electron Playwright journeys | Automated |
| Clean merge and conflict-resolution browser flows | `tests/e2e/workflow.spec.ts` launches the real Electron app with an isolated data root | two Playwright tests: clean merge and blocked-then-resolved conflict | Automated |
| Export resolves an immutable commit before compilation | `ProjectService.exportOtio` resolves the revision to an object ID, loads that snapshot, then compiles OTIO and restores sidecar relinks | application integration test | Automated |
| Offline operation | application and test flows use local files, native Git, and Electron IPC only | all core/integration/E2E tests run without a service dependency | Automated |

## Verification commands

Run from `snipsnap/` with the repository-pinned Node 22.22.0:

```bash
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm test
mise exec -- npm run test:integration
mise exec -- npm run test:e2e
mise exec -- npm run package
```

The test layers deliberately prove different things:

- unit/property tests prove deterministic model, OTIO, diff, commands, and merge rules;
- integration tests execute real Git 2.x repositories under temporary directories, including
  physical snapshot compaction with unchanged refs, index, history, and canonical reads;
- Playwright launches the packaged Electron entry and exercises renderer -> preload -> IPC ->
  services -> Git rather than replacing the API with mocks;
- the packaging check verifies Electron Forge can produce `out/snipsnap-linux-x64/snipsnap`.

## Honest validation boundary

DaVinci Resolve is not installed in the automated environment. Therefore this repository does
not claim that a live Resolve import/export has been completed. The checked OTIO fixture is a
small, synthetic Resolve-shaped fixture, and generated files are accepted by the official
OpenTimelineIO 0.18.1 parser. Before calling V1 release-ready, run the following manual gate on
the supported cut-only profile:

1. Export a timeline containing multiple tracks, clips, and gaps from the supported Resolve
   version.
2. Import it into SnipSnap and inspect the explicit unsupported-content count.
3. Edit, selectively stage, commit, branch, merge, and export an immutable commit.
4. Import that OTIO into Resolve, relink the external media, and compare clip order plus source
   in/out and durations; the tolerance is at most one frame.
5. Add the real exported OTIO (with private paths/media removed) to `tests/fixtures/` as a
   regression fixture.

OTIO core has no portable caption schema. V1 preserves SnipSnap captions through namespaced OTIO
metadata and tests that semantic round trip, but it does not claim that Resolve recreates native
caption objects. That fidelity must remain explicit rather than silently advertised.

## Storage and security notes

- Each project repository is generated below Electron `userData/v1-data/projects/<uuid>/repo`.
- The Git tree contains one complete canonical `timeline.json` snapshot per commit. Git's native
  pack/delta storage transparently shares bytes between similar snapshots; automatic maintenance
  is best-effort and never changes commits, refs, the semantic index, or the working snapshot.
- Source media URLs are stored beside the workspace in `media-links.json`, never in Git. They are
  used only to reconstruct external references during local OTIO export; footage is not copied.
- The BrowserWindow is sandboxed with context isolation on and Node integration off.
- The preload exposes only named workflow methods. Node filesystem/process/Git APIs are not
  exposed to the renderer.
- Production dependency audit is clean at this snapshot. Electron Forge's development toolchain
  may report transitive development-only advisories; do not apply breaking `npm audit --force`
  updates without verifying packaging and E2E again.
