# VideoGit — Engineering Plan

> Synthesized from `VideoGit_Feature_Implementation_Guide.docx` plus competitive research
> (Vit/Helix, Postlab, Frame.io, VideoFlow, Avid bin-locking, DaVinci collaboration, ReelMind).

---

## 1. Recommended architecture (the decision)

| Axis | Chosen | Primary alternative | Why chosen |
|------|--------|--------------------|------------|
| **A. Substrate** | **A1 — Native Git, timeline JSON in Git, media external** | A3 custom DAG | Real refs/merge-base/two-parent commits; ecosystem + restart safety; guide's core decision |
| **B. Merge** | **B1 — Conservative field-level 3-way** | B2 structural | Trustworthy, testable, audit-friendly; out-positions Vit's AI black box |
| **C. Editor** | **C1 — Standalone React/Vite web editor** | C2 NLE panel | NLE-agnostic & portable; no vendor lock |
| **D. Media/Preview** | **D1 — Local SHA-256 CAS + FFmpeg proxy** | D2 WebCodecs | Immutable dedup, S3-swappable, deterministic |

This combo directly beats competitors: NLE-agnostic (vs Vit/Postlab), deterministic merge
(vs Vit AI), semantic diffs (vs everyone).

---

## 2. Axis deep-dives (balanced)

### A — Version-control substrate
- **A1 (chosen):** Git owns commits/branches/tags/index/merge-base. Timeline = canonical JSON
  blobs. Media by SHA-256 outside repo. *Risk:* index/working-tree juggling → mitigate with
  per-project mutex + compare-and-swap `update-ref`.
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
- **C1 (chosen):** React + Zustand local state, Fastify command endpoints, frame-snapped
  pointer → typed edit commands → reducer → canonical save.
- **C2 (NLE panel):** only if a specific studio requires Resolve/Premiere integration post-v1.
- **C3 (headless/API-first):** viable later for CI/CD-of-video; the command API already makes
  this natural.

### D — Media & preview
- **D1 (chosen):** stream-upload + SHA-256, ffprobe validate, store original immutable,
  generate CFR proxy (1280x720/30/H.264/yuv420p/AAC). Preview via `HTMLVideoElement` + Web
  Audio + DOM captions from a `PreviewPlan`.
- **D2 (WebCodecs):** lighter storage but heavier client; revisit if proxy generation cost hurts.
- **Export:** typed `RenderIR` -> allowlisted FFmpeg arg array (shell disabled) -> temp MP4 ->
  ffprobe + decode-check -> atomic publish. Render cache keyed by commit+profile+asset-hashes.

---

## 3. Component / module map

- **Domain model** (`types`, Zod schemas, canonical JSON serializer, UUIDs, frame arithmetic) — shared everywhere.
- **Git service** (Node `child_process.spawn`, arg arrays, CAS ref updates, merge-base, two-parent commit).
- **Media store** (SHA-256 CAS, proxy gen, dedupe, immutable originals).
- **Semantic diff engine** (pure TS; powers status, staging, compare, merge-preview).
- **Three-way merge engine** (pure TS; B1 rules; conflict model).
- **Command/reducer layer** (edit commands -> validated model; workspace version guard).
- **API** (Fastify: import, status, stage, commit, branch, checkout, history, compare, merge, export, SSE progress).
- **Web editor** (React timeline, caption overlay, conflict resolver, history graph, compare view).
- **Job worker** (SQLite WAL leases, FFmpeg spawn, SSE progress, cancel/retry, recovery).
- **Recovery/observability** (startup reconcile, Pino correlation IDs, metrics).

---

## 4. Build sequence (vertical slices, from guide)

1. **Freeze model** — stable IDs, frame rules, canonical serialization, validation. Prove same timeline -> same state.
2. **Prove Git+merge headless** — baseline commit, two branches, independent + conflicting edits, merge-base, two-parent commit. No UI.
3. **Media pipeline** — import, hash, probe, proxy, preview two commits, validated export, no media dup.
4. **Edit+commit workflow** — UI -> commands, status, selective stage, commit, branch, checkout, history.
5. **Compare + conflict resolution** — timeline-aware change cards, synced previews, clean merge + resolver that can't finish invalid.
6. **Harden** — cancel, restart recovery, safe command exec, demo reset, e2e (Vitest/fast-check/Playwright), offline verification.

---

## 5. Key risks -> mitigations

- **Merge correctness** -> pure engine + property-based tests (`fast-check`) generating independent/conflicting edit pairs; golden render fixture.
- **Media escape / shell injection** -> all tool spawns use arg arrays, shell disabled, generated paths, no URL/protocol indirection.
- **Stale client overwrites** -> hunk IDs + CAS branch updates; branch-moved-during-merge -> stop & recompute.
- **Partial output publish** -> temp file + validate before atomic move; never publish on FFmpeg success alone.
- **Restart corruption** -> durable job rows, lease reclamation, SQLite transactions, Git integrity checks on boot.

---

## 6. Definition of done (per guide)

- Real Git objects (commits, branches, tags, refs, merge-bases, two-parent merges) survive restart.
- Media immutable, stored by content hash outside Git, not duplicated by branch/commit.
- Current commit, staging index, and working project remain distinct; a commit contains only staged edits.
- Every supported edit produces a human-readable semantic change tied to a stable clip/caption ID.
- Independent branch edits merge without losing either change.
- Same-field edits, delete-vs-modify, incompatible order, and invalid combined timing become explicit conflicts.
- A merge cannot finish while conflicts remain or the provisional timeline is invalid.
- Aborting a merge leaves the target branch unchanged; a stale client cannot overwrite a moved branch.
- Checkout refuses to destroy uncommitted work without an explicit choice.
- Preview and export are compiled from the same timeline state; historical actions resolve to immutable commit IDs.
- The exported MP4 is playable, contains expected streams/duration, passes ffprobe + a decode check.
- Cancellation, FFmpeg failure, timeout, and service restart do not publish partial output or corrupt repo state.
- Automated tests cover serialization, diff, merge rules, Git history, media deduplication, output validation.
- Browser tests complete both a clean merge and a conflict-resolution workflow from a reset project.
- The full edit -> stage -> commit -> branch -> compare -> merge -> resolve -> export demo succeeds repeatedly offline.

---

## 7. Open decisions to confirm before build

- Single local worker vs queue abstraction from day one (guide says single-node first; abstract the boundary now).
- Scope of "visual preset" enum (lock the allowlist early — it drives both preview CSS and FFmpeg filter compiler).
- Whether demo seed repo ships as Git bundle or scripted fixture.

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
