# VideoGit — Engineering Plan

> Synthesized from `VideoGit_Feature_Implementation_Guide.docx` plus competitive research
> (Vit/Helix, Postlab, Frame.io, VideoFlow, Avid bin-locking, DaVinci collaboration, ReelMind).

> **Status:** Authoritative V1 implementation plan. The system-architecture and cross-NLE documents are roadmap and research documents; if they conflict with this file, this file wins.

> **Approved V1.5 clarification (updated 2026-08-30):** DaVinci Resolve is the only video editor.
> The SnipSnap renderer must not expose timeline editing controls. Its local Resolve bridge observes
> the persisted project save marker and atomically exports one OTIO snapshot per new saved state.
> The newest save replaces WORKING automatically; SnipSnap never queues saves or turns them into
> hidden commits. The renderer reviews and stages semantic changes, commits canonical snapshots, and previews an
> immutable selected commit using locally linked media. Browser-compatible source playback is the
> initial preview path; managed CAS, CFR proxy generation, arbitrary effects, and verified renders
> remain D1/V2 work.

> **Approved V2 Kdenlive native-save vertical slice (updated 2026-08-31):** Kdenlive may act as a second
> timeline editor through its supported OpenTimelineIO import/export commands. SnipSnap may import
> a Kdenlive-exported `.otio` or the cut-only timeline subset of a native `.kdenlive`/MLT document,
> reconcile rewritten identifiers into the canonical model,
> and export an immutable commit to an atomic OTIO handoff that opens in Kdenlive. Every handoff
> must include a machine-readable capability/loss report. Portable tracks, clips, gaps, source
> ranges, media references, and markers are the supported interchange level. Captions, arbitrary
> effects, transitions, generators, disabled state, colour labels, Resolve Color/Fusion graphs,
> and editor-specific metadata must be reported as nonportable or best-effort rather than silently
> claimed. When connected to a native project, SnipSnap watches the saved file, converts each
> distinct `Ctrl+S` state into canonical WORKING, and atomically regenerates a sibling `.otio`.
> It never writes the native project or automates Kdenlive's UI. Canonical JSON remains the only
> Git source of truth; native effect/composition fidelity and baked cross-editor renders remain out
> of scope.

> **Approved V2 WebRTC peer-transfer slice (updated 2026-09-02):** The earlier same-network HTTP
> transfer is replaced by authenticated WebRTC data channels. A signaling-only WebSocket service
> is deployed behind WSS with STUN/TURN for cross-network ICE; the desktop opens no LAN listener.
> Signaling must never carry or store project data. One host may serve multiple connected editors;
> each editor can pull the host's latest committed refs and missing media into the existing local Git
> repository and local SHA-256 media store. The host remains the live source, so this is not durable
> cloud storage or an identity/permissions system. WebRTC payloads are bounded and backpressured,
> and existing dirty-workspace, semantic merge, checksum, and expected-old ref protections remain.
> Replacing the local project from the current branch's newest immutable commit updates local
> INDEX/WORKING only after explicit confirmation; it preserves Git history and media and never
> rewrites a native NLE project.

---

## 1. Recommended architecture (the decision)

| Axis | Chosen | Primary alternative | Why chosen |
|------|--------|--------------------|------------|
| **A. Substrate** | **A1 — Native Git, timeline JSON in Git, media external** | A3 custom DAG | Real refs/merge-base/two-parent commits; ecosystem + restart safety; guide's core decision |
| **B. Merge** | **B1 — Conservative field-level 3-way** | B2 structural | Trustworthy, testable, audit-friendly; out-positions Vit's AI black box |
| **C. Editor** | **C1 — Electron + React/Vite + typed preload IPC** | Fastify/HTTP adapter | Secure local Node access without exposing Node to the renderer |
| **D. Media/Preview** | **D0 — External media references for V1** | D1 local SHA-256 CAS + FFmpeg proxy | Keeps the MVP focused on timeline versioning; proxy/render infrastructure moves to V2 |

The V1 differentiator is trustworthy timeline versioning: native Git ancestry underneath a
typed semantic diff and merge layer. Media processing and cross-NLE portability remain V2 work.

The V1.5 product loop is:

```text
Resolve edit + project save -> internal atomic OTIO -> latest WORKING -> review/stage -> commit
             -> select commit -> semantic parent diff + local preview
             -> immutable OTIO export or create/switch branch from that commit
```

---

## 2. Axis deep-dives (balanced)

### A — Version-control substrate
- **A1 (chosen):** Git stores complete canonical timeline JSON snapshots and owns commits,
  parents, branches, tags, refs, and merge-base discovery. VideoGit computes semantic diffs and
  three-way merges in TypeScript; Git never text-merges timeline JSON.
- **Semantic staging:** VideoGit maintains complete `HEAD`, `INDEX`, and `WORKING` canonical
  snapshots. `diff(HEAD, INDEX)` is staged and `diff(INDEX, WORKING)` is unstaged. Applying a
  semantic hunk produces a new validated `INDEX`. Store that complete canonical JSON blob in
  Git's real `.git/index` using `hash-object` and `update-index --cacheinfo`; `write-tree` then
  creates the commit tree. Do not expose or depend on Git's line-oriented staging UI.
- **Safety:** Serialize repository mutations with a per-project mutex and move refs with
  compare-and-swap `update-ref <ref> <new> <expected-old>`.
- **Rejected now:** A2 (LFS) — server dependency + weak structured merge; A3 (custom DAG) —
  loses Git tooling; A4 (event-sourced) — replay nondeterminism. **Revisit A3 only if
  distributed multi-node history is needed.**

### B — Merge engine
- **B1 (chosen):** base/ours/theirs on typed model, stable-ID entity match, atomic field
  groups, explicit conflicts (same-value / delete-vs-modify / order / invalid-timing).
  Full-project validation after merge.
- **B2 (structural graph merge):** future enhancement for smarter ordering auto-merge once B1
  rules are proven (guide explicitly defers this).
- **B3 (AI merge):** consciously avoided for v1 — non-deterministic, unverifiable editorial intent.

### C — Editor / integration
- **C1 (chosen):** React + Zustand local state in the sandboxed renderer. A narrow typed preload
  bridge invokes application services through Electron IPC. Node filesystem, crypto, Git, and
  process APIs stay in the Electron main process.
- **Optional HTTP adapter:** Add Fastify only when a DaVinci companion script, CLI, or hosted
  client must call the same application services. It is not part of local V1.
- **C2 (NLE panel):** only if a specific studio requires Resolve/Premiere integration post-v1.
- **C3 (headless/API-first):** viable later for CI/CD-of-video; the command API already makes
  this natural.

### D — Media & preview
- **D0 (V1):** keep footage outside Git and outside the application store. Version canonical
  timeline decisions and stable media references only; checkout exports OTIO for Resolve.
- **D1 (V2):** add SHA-256 CAS, ffprobe validation, CFR proxies, `PreviewPlan`, `RenderIR`, and
  verified FFmpeg output when in-app preview/render becomes a committed product requirement.

---

## 3. Component / module map

- **Domain model** (`types`, Zod schemas, canonical JSON serializer, UUIDs, frame arithmetic) — shared everywhere.
- **Git service** (Node `child_process.spawn`, arg arrays, CAS ref updates, merge-base, two-parent commit).
- **Semantic diff engine** (pure TS; powers status, staging, compare, merge-preview).
- **Three-way merge engine** (pure TS; B1 rules; conflict model).
- **Command/reducer layer** (edit commands -> validated model; workspace version guard).
- **Electron main + preload** (Node application services exposed through narrow typed IPC handlers).
- **Electron renderer** (React timeline, semantic changes, history, branches, and conflict UI).
- **V2 services** (optional Fastify adapter, media CAS, FFmpeg worker, SQLite jobs, SSE, and hosted auth).

---

## 4. Build sequence (vertical slices, from guide)

1. **Freeze model** — stable IDs, frame rules, canonical serialization, validation. Prove same timeline -> same state.
2. **Prove Resolve interoperability** — round-trip the supported OTIO subset through Resolve before building the full UI.
3. **Prove Git+merge headless** — canonical snapshot commits, two branches, semantic diff, merge-base, conflicts, and a two-parent commit. No UI.
4. **Edit+commit workflow** — IPC-driven UI, `HEAD`/`INDEX`/`WORKING`, semantic staging, commit, branch, checkout, and history.
5. **Compare + conflict resolution** — timeline-aware change cards, clean merge, and a resolver that cannot finish an invalid timeline.
6. **Harden** — atomic writes, stale-ref tests, restart tests, fixtures, Vitest/fast-check, and Playwright acceptance flows.

---

## 5. Key risks -> mitigations

- **Merge correctness** -> pure engine + property-based tests (`fast-check`) generating independent/conflicting edit pairs; golden OTIO fixtures.
- **Git command injection** -> all tool spawns use arg arrays, shell disabled, generated repository paths, and validated ref names.
- **Stale client overwrites** -> hunk IDs + CAS branch updates; branch-moved-during-merge -> stop & recompute.
- **Partial repository mutation** -> create immutable objects first and update the branch ref last with expected-old CAS.
- **Restart corruption** -> atomic application-state writes and Git integrity checks on boot.

---

## 6. Definition of done (per guide)

- Real Git objects (commits, branches, tags, refs, merge-bases, two-parent merges) survive restart.
- Footage never enters Git; canonical snapshots contain stable media references only.
- Current commit, staging index, and working project remain distinct; a commit contains only staged edits.
- Every supported edit produces a human-readable semantic change tied to a stable clip/caption ID.
- Independent branch edits merge without losing either change.
- Same-field edits, delete-vs-modify, incompatible order, and invalid combined timing become explicit conflicts.
- A merge cannot finish while conflicts remain or the provisional timeline is invalid.
- Aborting a merge leaves the target branch unchanged; a stale client cannot overwrite a moved branch.
- Checkout refuses to destroy uncommitted work without an explicit choice.
- OTIO exports are compiled from validated canonical snapshots resolved to immutable commit IDs.
- Automated tests cover serialization, OTIO round trips, diff, merge rules, Git history, and stale-ref protection.
- Browser tests complete both a clean merge and a conflict-resolution workflow from a reset project.
- The full import -> diff -> stage -> commit -> branch -> compare -> merge -> resolve -> OTIO export demo succeeds repeatedly offline.

---

## 7. Open decisions to confirm before build

- Whether the demo seed repository ships as a Git bundle or a scripted fixture.

---

## Appendix — USP angles (positioning reference)

1. **"Git, but for your timeline."** Mental model for technical creators.
2. **Semantic diffs, not opaque blobs.** Status reads "Caption trimmed by 30 frames."
3. **Merge like a developer, not a lock.** Explicit base/ours/theirs vs Avid bin-lock / Postlab manual merge.
4. **NLE-agnostic & browser-native.** vs Vit (Resolve-only) / Postlab (Premiere-only).
5. **Media stays outside Git, immutable & deduplicated.** No repo bloat.
6. **Deterministic, provable merge (no magic AI).** Differentiator from Vit's AI black box.
7. **One timeline model -> preview == export == merge.**
8. **Offline, local-first, reproducible.**
9. **Auditability for agencies/legal** (commit + author + UTC + tags).
10. **Reproducible renders via content-addressed cache.**
