# SnipSnap project handoff

> Snapshot date: 2026-08-30
>
> This document is a restart aid for a new developer or coding-agent conversation. It does not
> override `AGENTS.md` or the documentation precedence in `docs/README.md`. Always inspect the
> current branch and diff before acting because the repository may have moved since this snapshot.

## Paste this into a fresh coding-agent conversation

```text
Continue work on SnipSnap in this repository. First read AGENTS.md, docs/README.md,
docs/VideoGit_Engineering_Plan.md, docs/V1_IMPLEMENTATION_STATUS.md, and docs/HANDOFF.md.
Then inspect git status/log and the implementation before proposing or changing anything.

Preserve the core product rule: DaVinci Resolve is the editor; SnipSnap reviews, versions,
branches, merges, previews, and exports immutable timeline state. Do not add in-app video editing.
Git stores canonical timeline snapshots and ancestry; semantic diff/staging/merge stay in
TypeScript and Git must not text-merge timeline.json. Keep renderer -> typed preload IPC -> main
process boundaries intact.

Treat additional cross-NLE work beyond the approved Kdenlive OTIO slice as new V2 scope that needs
an explicit plan and honest fidelity rules. Do not claim Resolve Color/Fusion/plugin portability through OTIO. Run the relevant tests,
inspect the diff, and use conventional commits without sweeping unrelated changes.
```

## Repository snapshot

- Repository: `Nainikap/WhamBamVITShazam`
- Working directory during this audit: `C:\Users\Tarun\VIT\WhamBamVITShazam`
- Active branch at audit start: `main`
- Remote-tracking state at audit start: clean and equal to `origin/main`
- Application implementation baseline before these handoff docs: `520a8b8`
  (`fix(preview): disable Windows video overlays`)
- Electron application: `snipsnap/`
- Resolve scripts: `resolve/`
- Official scope rules: `AGENTS.md`

Do not hard-reset to the baseline hash. It is an orientation marker, not a restoration target.

## Product decision

SnipSnap has a Resolve-first workflow plus an approved Kdenlive OTIO interchange slice:

```text
Resolve save
  -> atomic OTIO snapshot / database fallback
  -> stable-ID reconciliation
  -> canonical timeline WORKING
  -> semantic INDEX staging
  -> complete timeline snapshot in native Git commit
  -> branches / history / compare / three-way merge
  -> local commit preview / immutable OTIO export
```

There is no editor in SnipSnap. The command reducer remains as pure domain/application support and
test tooling, but renderer IPC does not expose timeline editing commands.

The source of truth is canonical JSON, not `.drp`, raw `.otio`, `.kdenlive`, or MLT. OTIO is an
interchange format. Resolve and future NLE adapters may rewrite identifiers or omit proprietary
metadata, so the hub must reconcile into stable canonical identities before diff or merge.

## What is implemented

### Domain and OTIO

- `src/domain/model.ts` defines strict Zod schemas for projects, sequences, tracks, assets, clips,
  gaps, transitions, captions, markers, effects, decorations, frame ranges, and rational rates.
- Validation checks unique identities, graph relationships, asset bounds, track membership, and
  caption bounds.
- `src/domain/canonical.ts` normalizes strings, sorts keys with locale-independent comparison,
  serializes deterministic JSON, hashes state, and derives deterministic UUIDs.
- `src/adapters/otio/otio.ts` imports/exports the supported OTIO subset, preserves unmodelled JSON
  in `extras`, stores stable IDs under `metadata.videogit`, reports unsupported objects, and keeps
  machine-local media URLs in a sidecar map.
- Captions are SnipSnap metadata represented through OTIO clips because OTIO core has no portable
  native caption schema.

### Semantic changes and Git

- `src/diff/semantic-diff.ts` emits stable semantic hunks for every modelled field and preserved
  extras. It groups blade cuts and structural dependencies into atomic valid changes.
- Hunk identities bind the base digest. `applySemanticHunks` rejects stale hunks.
- `src/git/process.ts` removes ambient Git configuration, disables prompts, uses argument-array
  `spawn` with `shell: false`, and detaches Git from the inherited console on Windows.
- `src/git/repository.ts` writes canonical blobs to the real Git index, creates trees/commits with
  plumbing commands, validates refs, moves refs with expected-old `update-ref`, imports peer tags
  under peer-qualified refs, and performs best-effort pack/delta maintenance.
- Commits contain only `timeline.json`; footage and local media paths remain outside Git.
- Commit calls validate both the expected HEAD and expected semantic index digest.

### Workspace, history, branches, and merge

- `src/application/project-service.ts` owns per-project serialized mutations and atomic sidecar
  state under Electron `userData/v1-data/projects/<project UUID>/`.
- `HEAD`, `INDEX`, and `WORKING` are distinct. Status exposes staged, unstaged, and cumulative
  `HEAD -> WORKING` changes.
- Checkout and historical branch creation reject dirty work unless discard is explicit.
- Historical selection resolves to an immutable commit, computes parent diff, and builds a preview.
- `src/merge/three-way.ts` combines independent fields and raises explicit conflicts for same-field,
  delete/modify, order, and invalid combined graphs.
- Merge sessions persist provisional structure plus validated base/ours/theirs alternatives.
  Completion rechecks branch, HEAD, index digest, working digest, staged state, and pending source
  state before creating a two-parent commit. Abort leaves the target ref unchanged.
- The resolver supports current/incoming/base and a limited **Accept both** only when the merge
  module can assign deterministic editorial meaning.

### Resolve integration

- `resolve/SnipSnapSaveBridge.py` polls Resolve's persisted `lastModifiedDate` marker, exports the
  active timeline once per distinct saved state, publishes OTIO atomically, and emits JSON-line
  events.
- `ResolveBridgeService` validates bridge events. Windows uses `pyw -3` to avoid a visible console.
- Only the project currently open in SnipSnap owns the active Resolve bridge.
- A Resolve-database fallback copies SQLite before reading, reconstructs tracks/cuts/gaps, and
  probes MP4/MOV media for frame rate and dimensions instead of guessing.
- `source-sync.ts` reconciles rewritten sequence, track, asset, clip, gap, transition, and caption
  IDs so ordinary Resolve rewrites do not appear as noisy delete/add pairs.
- Manual watched OTIO remains a fallback. That directory watcher has a short coalescing delay;
  managed Resolve save sync is marker-driven rather than edit-event debounce.
- `SnipSnapSync.py` and its sibling `resolve_connection.py` can be installed in Resolve's Scripts
  menu and export `.drp` + timeline OTIO + manifest.

### Renderer and preview

- The left panel shows staged/unstaged changes and commit history. Selecting a commit expands its
  semantic changes; selecting it again closes the disclosure.
- **All changes** opens the complete parent comparison. Each individual hunk can focus the diff.
- The right inspector exposes LAN state, branch switch/create, merge, timeline facts, and a compact
  coloured commit graph.
- `CommitPlayer` uses source media ranges, captions, audio volume, and `none/warm/cool/mono` CSS
  presets. Space toggles playback when the video surface has focus.
- Higher video tracks are composited into the preview plan. The comparison viewer stops both sides
  at the shorter commit to avoid buffering after one revision ends.
- The player holds the prior decoded frame during commit source/seek transitions to reduce flashes.
- Windows disables Chromium DirectComposition video overlays while leaving general GPU composition
  enabled. This addresses the full-window black overlay reported on the first commit seek.
- The dashboard intro uses a vendored Vercel/vgpu WebGPU prism with the retained MIT license. The
  project view unmounts that GPU stage.

### LAN demo

- One app can host a project and produce a pairing code; a second can join, pull, and push.
- Requests use a random 256-bit pairing secret, HMAC authentication, timestamps/nonces, and
  AES-256-GCM encrypted bodies.
- Git bundles carry every branch/tag/commit/tree. Fetched peer tags are namespaced rather than
  overwriting local tags.
- Media transfers outside Git in 8 MiB chunks with chunk and whole-file SHA-256, persisted resume
  state, streaming final verification, content-addressed storage, and atomic publication.
- Pull fast-forwards safe branches, adds missing branches, and preserves divergence under
  peer-qualified branches. Push uses the remote head last seen by the peer as its stale check.

## Known limits and unfinished work

### Release validation

- Automated tests use synthetic and sanitized OTIO. A real multi-track Resolve project with
  representative MP4/MOV codecs still needs the manual gate in `V1_IMPLEMENTATION_STATUS.md`.
- Automated evidence does not prove every Resolve version, codec, native caption object, Color node,
  Fusion graph, transition plugin, or third-party effect.
- The latest Windows DirectComposition mitigation passed packaged E2E, but the previous chat did
  not record a final user confirmation after that exact flag was applied. Re-test first-commit
  selection in the user's real Windows/Resolve workflow before declaring that incident closed.

### Linux

- Forge has Debian/RPM makers and the Python connection helper includes `/opt/resolve` paths.
- `SnipSnapSync.py` writes Linux exports to `$XDG_DATA_HOME/SnipSnap/resolve` or
  `~/.local/share/SnipSnap/resolve`.
- The Electron `defaultResolveRoots`, `resolveDatabaseRoots`, and `resolveScriptFolders` functions
  now have explicit Linux/XDG defaults plus `/opt/resolve` script discovery, with integration tests.
- Environment overrides exist: `SNIPSNAP_RESOLVE_ROOT`, `SNIPSNAP_RESOLVE_DATABASE`,
  `SNIPSNAP_RESOLVE_SCRIPTS`, and `SNIPSNAP_RESOLVE_SCAN` for nonstandard installations.
- The Electron app and Kdenlive handoff have been exercised in an Omarchy Hyprland/Wayland session;
  Kdenlive requires its explicit File > OpenTimelineIO Import action because a positional `.otio`
  argument is treated as a bin clip. Packaged Playwright runs hidden and remains the repeatable UI
  acceptance path without mapping test windows into Hyprland.

### Cross-NLE / Kdenlive

- `src/adapters/kdenlive/` assesses OTIO capability and emits typed fidelity reports.
- A Kdenlive-exported OTIO can be imported, watched, reconciled after UUID rewrites, and committed
  through the normal HEAD/INDEX/WORKING workflow.
- Any immutable commit can be atomically exported with a sibling JSON loss report and opened in
  Kdenlive through a literal no-shell process argument.
- OTIO is the correct portable interchange for cuts/tracks/markers, but it cannot carry arbitrary
  proprietary Resolve colour/effect graphs into Kdenlive.
- For exact visible appearance across NLEs, use a baked render or portable overlay. For editable
  cross-NLE effects, define a small explicit canonical effect IR and implement it in each adapter.
- Native `.kdenlive`/MLT parsing and automatic export-on-save remain unimplemented. A direct MLT
  adapter may be useful later for Kdenlive-specific fidelity, but MLT should not replace
  canonical JSON as Git source of truth.

### LAN/media

- Same-network reachability only: no NAT traversal, discovery, relay, cloud auth, permissions, or
  hosted review workflow.
- Git bundle request/response bodies are capped at 64 MiB and held in memory.
- Pull downloads host media. Push sends Git history only; newly introduced media on the peer is not
  uploaded to the host.
- There is no FFmpeg proxy generator. Originals are transferred when that is all the host has.
- Browser preview depends on Chromium codec support and is not a verified final render.

### Repository cleanup candidates

- Root `modifyOTIO.py`, `testOTIO.py`, `output.otio`, and `output_modified.otio` are early scratch
  helpers/assets. They are not part of the Electron workflow and should be reviewed before removal.
- `snipsnap/README.md` is older and less complete than the repository root README.
- There is no tracked GitHub Actions workflow. Verification is local.

## Test evidence at handoff

The audit ran from `snipsnap/` on Windows with Git 2.52.0 and Node 24.12.0 because `mise` was not
installed in that shell. Release/package work should still use the pinned Node 22.22.0.

Current audit results before the documentation edit:

- `npm run typecheck`: passed;
- `npm run lint`: passed;
- `npm test`: 13 files passed, 69 tests passed, 1 optional OTIO/Python test skipped;
- `npm run test:integration`: 10 files passed, 62 tests passed.

Earlier validation on the same implementation baseline also passed packaging and 18 packaged
Electron E2E journeys, including responsive layouts, Resolve refresh, commit diff focus, linked
playback termination, historical branching/restore, clean/conflicting/multi-contributor merges,
blade-cut naming, playback/scrubbing, and two-instance LAN join/push. Re-run E2E after material UI,
IPC, preview, Resolve, or collaboration changes rather than treating this paragraph as permanent.

Official full gate:

```bash
cd snipsnap
mise install
mise exec -- npm ci
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm test
mise exec -- npm run test:integration
mise exec -- npm run build
mise exec -- npm run package
mise exec -- npm run test:e2e   # packaged UI acceptance; slower
```

## Recent Windows incident fixes

These commits explain behavior that can otherwise look arbitrary:

- `9d2b61c` isolates live Resolve database reads through snapshots;
- `598a236` launches Resolve sync with the windowless Windows Python launcher;
- `a66ad94` keeps the editor mounted/responsive during timeline refresh and adds responsive layouts;
- `d5da6a5` ensures only the currently open project watches the active Resolve project;
- `533d393` detaches Git for Windows from the inherited console host;
- `520a8b8` disables DirectComposition video overlays to avoid a full-window black surface during
  the first historical video seek.

Do not remove these as cosmetic changes without reproducing the original Windows behavior and
running packaged Electron tests.

## Recommended next work

If the next goal is simply to move development to Linux:

1. clone/pull `main` and install the pinned Node version;
2. use this file to start a new agent conversation rather than copying the enormous local session;
3. validate the tested Linux/XDG Resolve paths against an installed Resolve build and real project;
4. package Debian/RPM and run the same unit/integration/E2E gates;
5. copy footage separately because it is intentionally not in Git.

The approved Kdenlive OTIO vertical slice now covers editor identity, capability/loss schemas,
portable L0/L1 import/watch, stable reconciliation, and canonical-to-Kdenlive export/open. Next
cross-NLE work should validate more real Resolve/Kdenlive golden projects, consider direct MLT only
for explicitly selected Kdenlive-only fidelity, and add baked artifacts for nonportable visuals
rather than pretending those effects are editable everywhere.

## Secrets and local data

- Never commit `clips/`, `deliverables/`, `node_modules/`, `out/`, `.vite/`, runtime repositories,
  `.codex/` session files, pairing secrets, or media sidecars.
- A Google Stitch API key was pasted into the previous chat. It is intentionally absent from this
  repository and handoff. Rotate/revoke it before reuse; do not copy it into source or Markdown.
- A local Codex session file may contain that secret and machine paths. If exact chat history is
  copied to Linux, transfer it privately and treat it as sensitive. This handoff is the safer,
  smaller context-transfer mechanism.
