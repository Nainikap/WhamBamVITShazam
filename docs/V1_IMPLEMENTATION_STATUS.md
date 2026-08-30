# VideoGit V1/V1.5 and LAN MVP implementation status

> Updated: 2026-08-30
>
> This is an evidence map, not a replacement for the authoritative
> [`VideoGit_Engineering_Plan.md`](./VideoGit_Engineering_Plan.md). The implementation is in
> `snipsnap/`.

## Current result

The local V1 architecture and the approved Resolve-only V1.5 workflow are implemented end to end:

```text
React/Zustand renderer
  -> typed context-isolated preload IPC
  -> Electron main
  -> ProjectService
  -> canonical model / OTIO / semantic diff / three-way merge / native Git
```

SnipSnap contains no video-editing controls. Resolve remains the editor. The save bridge observes
Resolve's persisted `lastModifiedDate`, atomically exports once per distinct save marker, and makes
only the newest validated snapshot WORKING. `HEAD -> WORKING` is shown as separate semantic hunks;
only an explicit SnipSnap commit creates history. Manual OTIO watching remains a fallback. Commits
are previewed from locally linked, browser-compatible media through a restricted Electron protocol.

An additive V2 LAN-demo slice now lets one desktop host a project and another join with a pairing
code. It transfers native Git bundles for complete commits/branches/tags and sends footage outside
Git as encrypted, resumable, SHA-256-verified chunks. Received files are deduplicated in a local
content-addressed store and relinked for commit preview. Pull fast-forwards clean branches, preserves
divergence under peer-qualified branches, and Push rejects stale or non-fast-forward updates.

This LAN slice is not a hosted collaboration system. It has no NAT traversal, relay, discovery,
permissions, cloud storage, FFmpeg proxy generation, background queue, or upload of newly introduced
peer media during Push. Both computers must be able to reach each other on the same network, the host
must keep SnipSnap open, and current originals are sent when no pre-existing proxy asset is available.

An approved V2 Kdenlive OTIO slice also lets a Kdenlive export become a watched SnipSnap project and
prepares any immutable commit for Kdenlive through an atomic OTIO handoff. Every handoff includes a
validated JSON fidelity report. This is portable editorial interchange, not native `.kdenlive`/MLT
versioning or a claim that captions, effects, generators, or Resolve Color/Fusion state are editable
across NLEs. Kdenlive's supported File > OpenTimelineIO Import action remains an explicit step because
its command line cannot invoke that importer.

## Requirement traceability

| Engineering Plan requirement | Implementation | Automated evidence | Status |
|---|---|---|---|
| Stable IDs, integer half-open frame ranges, rational FPS, bounded fields, full relationship validation | `src/domain/` Zod schemas and frame helpers | `tests/domain.test.ts` | Automated |
| Deterministic NFC canonical JSON | `src/domain/canonical.ts` | key-order, Unicode, digest, and stable UUID property tests | Automated |
| Minimal Resolve OTIO cut subset | `src/adapters/otio/` imports/exports tracks, clips, gaps, timing, and SnipSnap caption metadata | `tests/otio.test.ts`, including parse by official OpenTimelineIO 0.18.1 when installed | Automated for OTIO; Resolve validation pending |
| Kdenlive OTIO vertical slice | `src/adapters/kdenlive/`, typed IPC, watched Kdenlive source bindings, immutable handoffs, native launcher discovery, and machine-readable loss reports | `tests/kdenlive.test.ts`, `tests/kdenlive-launcher.test.ts`, `tests/kdenlive.integration.test.ts`, and packaged `tests/e2e/kdenlive.spec.ts` | Automated plus live Linux/Kdenlive gate |
| Footage and machine-local paths never enter Git | canonical assets contain fingerprint/name/length; relink URLs live in untracked `media-links.json` application state | Git integration asserts the commit tree contains only `timeline.json` and its blob has no source path | Automated |
| Real Git commits, branches, refs, tags, merge-base, and two-parent commits | `src/git/` uses native Git plumbing through `spawn` argument arrays with `shell: false`; Git pack/delta maintenance compacts similar snapshots without changing their logical format | `tests/git.integration.test.ts` and `tests/application.integration.test.ts` inspect actual object types, parents, trees, refs, tags, compaction behavior, and `git fsck` | Automated |
| Compare-and-swap ref safety | immutable objects are created first; refs move last through `update-ref <new> <expected-old>` | stale-ref unit/integration cases, including a target moved during conflict resolution | Automated |
| Distinct HEAD / INDEX / WORKING snapshots | HEAD is read from a commit, semantic INDEX is the real Git index, WORKING is atomically persisted application state | selective-stage integration test proves a commit contains only one of two working edits | Automated |
| Semantic status and atomic staging | `src/diff/` emits stable-ID hunks for trims, ranges, fields, entities, and order; hunk IDs bind the base digest | diff/command unit tests cover selective staging, atomic trim/order, and stale hunk rejection | Automated |
| No in-app video editing | renderer contains only Resolve sync, review, staging, history, branch, export, and preview controls; the legacy pure command reducer remains headless test/merge support and is not exposed over preload | typecheck plus packaged Electron journeys | Automated |
| Resolve save synchronization | a supervised Python bridge polls only Resolve's persisted save marker (not edit events), atomically hands off one OTIO per new marker, validates JSON-line events, replaces latest WORKING without moving HEAD/INDEX, and exposes cumulative `HEAD -> WORKING` hunks; manual OTIO watch/apply remains a fallback | save-bridge unit/process integration, multi-hunk application integration, source-sync fallback tests | Automated except live Resolve gate |
| Conservative field-level three-way merge | `src/merge/` implements one-sided, same-value, different-field, same-field, delete/modify, order, and whole-project validation rules | unit/property tests cover independent edits, same-field choice, delete/modify restoration, incompatible order, and invalid combined timing | Automated |
| Persisted conflict resolution, validation gate, and safe abort | atomic merge-session files store immutable base/parent IDs and provisional state; complete uses target-ref CAS | application integration and Electron E2E conflict flow | Automated |
| Dirty checkout guard and restart safety | checkout requires no pending Resolve candidate, staged changes, or working changes unless explicitly discarded; workspace/index/head validate after restart | application integration tests | Automated |
| Clickable commit history and parent diff | selecting history resolves an immutable object ID, loads its full snapshot, and computes a semantic diff against the selected parent | application integration and packaged Electron Playwright | Automated |
| Branch from historical commit and safe restore | clean branch-from-revision switches HEAD/INDEX/WORKING together; restore writes the selected snapshot into WORKING so history is preserved | application integration and packaged Electron Playwright | Automated |
| Commit preview and media relink | pure `PreviewPlan` compiler orders source ranges from the selected commit; local media links stay outside Git and are served through a fingerprint-addressed custom protocol | preview unit test, media-link integration, packaged viewer journey | Automated for plan/wiring; real-codec gate pending |
| Resolve sync and historical-branch browser flows | `tests/e2e/workflow.spec.ts` launches the real packaged Electron entry with an isolated real Git repository and watched OTIO file | two Playwright tests cover automatic detection through commit preview, plus old-commit branching/switch/restore | Automated |
| Export resolves an immutable commit before compilation | `ProjectService.exportOtio` resolves the revision to an object ID, loads that snapshot, then compiles OTIO and restores sidecar relinks | application integration test | Automated |
| Offline operation | application and test flows use local files, native Git, and Electron IPC only | all core/integration/E2E tests run without a service dependency | Automated |
| LAN repository clone/pull/push | native Git bundles carry every branch, tag, commit, parent, and full timeline tree; ref updates retain dirty/stale/non-fast-forward guards | `tests/collaboration.integration.test.ts` imports complete history and proves peer push plus host pull | Automated |
| Resumable verified media transfer | 8 MiB chunks use per-chunk and whole-file SHA-256; progress metadata survives restart; completed files publish atomically into a local CAS and relink outside Git | `tests/media-transfer.test.ts` covers resume and corruption rejection; collaboration integration verifies preview media bytes | Automated |
| Encrypted LAN pairing | the pairing code contains a random 256-bit secret; every request is timestamped, nonce-protected, HMAC-authenticated, and AES-256-GCM encrypted | collaboration integration exercises the real loopback HTTP transport without mocks | Automated for protocol; external security review pending |
| Desktop Host/Join/Pull/Push workflow | typed IPC exposes only collaboration use cases; dashboard joins a peer and editor shows hosting, pairing, sync controls, and transfer progress | packaged Electron Playwright launches two isolated app instances, joins, then pushes a real branch | Automated |

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
- Playwright launches the packaged Electron entry and exercises watched OTIO -> renderer ->
  preload -> IPC -> services -> Git -> immutable preview plan rather than replacing the API with
  mocks; it also launches two app instances for a real Host -> Join -> Push UI journey;
- the packaging check verifies Electron Forge can produce the platform package (for example,
  `out/SnipSnap-win32-x64/SnipSnap.exe` on Windows), and E2E launches that package's generated
  `resources/app.asar` through the Electron automation harness.

## Honest validation boundary

Representative camera codecs are not available in the automated gate. The checked fixtures include
synthetic and sanitized Resolve-shaped exports, but the suite does not claim every Resolve build or codec has been
previewed. Generated files are accepted by official
OpenTimelineIO 0.18.1. Before calling V1.5 release-ready, run this manual gate:

1. Open a timeline containing multiple tracks, clips, and gaps in the supported Resolve version.
2. Start save sync in SnipSnap, save the Resolve project once, and confirm the bridge reports the
   correct project/timeline without requiring a manually named OTIO file.
3. Change at least two supported fields, save once, and confirm WORKING automatically shows two or
   more cumulative `HEAD -> WORKING` hunks while HEAD and INDEX remain unchanged.
4. Relink representative MP4/MOV media and verify seek, ordered playback, missing-media recovery,
   and switching between at least two historical commit previews.
5. Create a branch from an old commit, export that immutable commit, import it into Resolve, and compare clip order plus source
   in/out and durations; the tolerance is at most one frame.
6. Add the real exported OTIO (with private paths/media removed) to `tests/fixtures/` as a
   regression fixture.

OTIO core has no portable caption schema. V1 preserves SnipSnap captions through namespaced OTIO
metadata and tests that semantic round trip, but it does not claim that Resolve recreates native
caption objects. That fidelity must remain explicit rather than silently advertised.

Resolve's scripting/OTIO APIs also do not expose a portable, complete Color-page node graph. Color
grades are therefore reported as unsupported rather than falsely versioned; supported editorial,
audio, transition, marker, metadata, and caption fields produce independent semantic hunks.

Kdenlive's documented OTIO boundary covers multiple tracks, clips, and markers. The automated gate
also proves stable reconciliation after SnipSnap IDs are removed, literal no-shell process arguments,
and immutable report publication. It does not claim native MLT fidelity or automatic OTIO export on
every Kdenlive save. See [`KDENLIVE_INTEGRATION.md`](./KDENLIVE_INTEGRATION.md).

## Storage and security notes

- Each project repository is generated below Electron `userData/v1-data/projects/<uuid>/repo`.
- The Git tree contains one complete canonical `timeline.json` snapshot per commit. Git's native
  pack/delta storage transparently shares bytes between similar snapshots; automatic maintenance
  is best-effort and never changes commits, refs, the semantic index, or the working snapshot.
- Source media URLs are stored beside the workspace in `media-links.json`, never in Git. They are
  used for immutable OTIO export and local commit preview; footage is not copied.
- Media received from a LAN peer is stored under `v1-data/media/sha256/` by its full content digest.
  Partial files and download metadata remain restart-safe until verification succeeds. Pairing and
  remote metadata stay in application storage, outside the project Git repository.
- The custom `snipsnap-media://asset/<project>/<fingerprint>` handler resolves only registered
  sidecar links in the main process. The renderer never receives arbitrary filesystem access.
- The BrowserWindow is sandboxed with context isolation on and Node integration off.
- The preload exposes only named workflow methods. Node filesystem/process/Git APIs are not
  exposed to the renderer.
- Production dependency audit is clean at this snapshot. Electron Forge's development toolchain
  may report transitive development-only advisories; do not apply breaking `npm audit --force`
  updates without verifying packaging and E2E again.
