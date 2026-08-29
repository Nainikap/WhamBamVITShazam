# VideoGit Cross-NLE Universal Hub — Brainstorm, Feasibility & Build Plan

> Source: `VideoGit_Feature_Implementation_Guide.docx` (251 paras) + `VideoGit_Engineering_Plan.md:1-132` + live research on OTIO / EDL / AAF / XML (May 2026)
> Generated: 2026-08-29 | Skill: `brainstorm` (Stages 1-5)
> Idea lead: Common platform for different video editing platforms (e.g., Adobe Premiere -> DaVinci Resolve) to exchange assets/videos without breaking, built on VideoGit.

> **Status:** Future product research, not the current implementation plan. `VideoGit_Engineering_Plan.md` is authoritative for V1. Cross-NLE adapters, media CAS, relinking, Fastify, FFmpeg jobs, and hosted infrastructure are V2 candidates.

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Stage 1 — Pin Down the Actual Problem](#stage-1--pin-down-the-actual-problem)
3. [Stage 2 — End-to-End Architecture](#stage-2--end-to-end-architecture)
4. [Stage 3 — Gaps & Fixes](#stage-3--gaps--fixes)
5. [Stage 4 — Rebuilt Architecture & Vertical Slices](#stage-4--rebuilt-architecture--vertical-slices)
6. [Stage 5 — USP Pressure-Test & Product Options](#stage-5--usp-pressure-test--product-options)
7. [Feasibility Assessment](#feasibility-assessment)
8. [Viability Assessment](#viability-assessment)
9. [What We Can Build Along These Lines (Lead Expansion)](#what-we-can-build-along-these-lines-lead-expansion)
10. [Implementation Plan](#implementation-plan)
11. [Open Questions (Decisions Before Build)](#open-questions-decisions-before-build)
12. [References](#references)
13. [Appendix — VideoGit USP Angles (Robustness)](#appendix--videogit-usp-angles-robustness)

---

## Executive Summary

**Problem:** Editors on mixed NLEs lose 1-3h per handoff to manual XML/AAF/EDL + zip relink that silently drops effects and slips timecode. Review/storage tools (Frame.io, Postlab, LucidLink) don't provide *editable* timeline portability.

**Solution:** A **Canonical Timeline Hub + Content-Addressed Asset Layer + NLE Adapter Kit** built on VideoGit. VideoGit already solves the hard part: `Guide.docx:008` — *Git stores edit decisions; SHA-256 CAS stores media; VideoGit supplies timeline-aware diff/merge/preview/export* — with stable UUIDs, integer frames half-open `[120,240)`, and rational time math (`Guide.docx:071`). Reuse that as the hub instead of N×N direct translators (need only N+1).

**Feasibility (2026): HIGH for L0-L1, LOW for full effects.** OTIO is now native in Resolve, beta in Premiere 25.6+, preview in Avid, plus Final Cut/Blender — the first true vendor-neutral interlingua. Cuts/timecode/media can be lossless; color/effects/plugins cannot — must be honest loss report, not pretend lossless.

**Viability: HIGH wedge, MEDIUM moat.** Wedge = Asset Relink Service + one-shot Universal Hub (Premiere <-> Resolve). Moat = Git-versioned branching/merging across NLEs + SHA dedup + reproducible renders. Proven API shape exists (`videogen.io` BUNDLE/REMOTE_URLS) but they lack Git/merge.

**Recommended roadmap after V1:** First prove local Resolve OTIO versioning from the Engineering Plan. Then add **Universal Hub (OTIO + FCP7 XML + FCPXML, L0-L1)** -> **Relink Service** -> **Git-backed merge across NLEs**. Defer AAF binary and unlimited effects until the adapter model is proven.

---

## Stage 1 — Pin Down the Actual Problem

### 1.1 Personas (not "all editors")

| Persona | Scenario | Pain today |
|---|---|---|
| **Freelance hopper (you)** | You cut in Premiere, client demands Resolve project | Export FCP7 XML or AAF + zip media + manual relink. 30-60 min. Effects drop, timecode slips if not CFR. |
| **Small post team, mixed NLEs** | Editor on Premiere, colorist on DaVinci | Frame.io = comments only (not editable) ; Postlab = checkout/lock, Premiere-only |
| **Template / education seller** | Sell template made in Premiere, buyer on Final Cut | Buyer cannot open. No conversion without rebuild. |

### 1.2 What they do today & real cost

*   **Workflow:** Export XML/AAF/EDL + reference QT + media folder. Receiver re-imports, relinks by `reel_name + timecode`, cleans broken transitions. [cutconvert.com — EDL vs XML vs AAF:1] , [cutsio.com — EDL guide:1]
*   **Why it breaks:**
    *   EDL = 1 video track + 4 audio, no effects, plain-text fallback only [cutsio.com:1]
    *   Premiere XML (`xmeml v5`) != Final Cut FCPXML 1.8 — incompatible flavors [cutconvert.com:1]
    *   AAF = binary, unreadable, sample-rate mismatches drop audio [forums.steinberg.net]
    *   OTIO Premiere support still beta (25.6+), clip names revert to filenames [community.adobe.com:1]
    *   Post houses demand *all three* (AAF/XML + EDL) as redundancy — proof no single format is trusted [cutconvert.com:1]
*   **Cost:** 1-3h per handoff + render-check + "where is `intro.mp4`?" Slack thread. "Not breaking" is baseline expectation, not a USP.

### 1.3 Core insight from VideoGit

`Guide.docx:010-011` — *Video editing tools are good at changing a timeline, weak at showing what changed or combining work. VideoGit applies Git workflow to editing decisions.* The **important boundary** is: Git stores complete canonical timeline JSON snapshots and owns commits, parents, branches, tags, refs, and merge-base discovery. Git does not store footage and must never text-merge timeline JSON. VideoGit computes semantic diffs, staging, and merges in TypeScript.

That **canonical model** is exactly the hub needed for cross-NLE exchange. Today you need `N*(N-1)` translators. With hub: `N` adapters.

### 1.4 Success metrics (measurable)

*   Round-trip `Premiere(cuts only) -> Hub -> Resolve -> Hub -> Premiere` preserves cut count, order, source in/out within 1 frame (property test).
*   Media dedup: same SHA-256 imported from 2 NLEs stores once (`Engineering_Plan.md:15`).
*   Handoff time: <5 min vs 45 min today.
*   Loss report emitted for every export; zero silent drop.

### 1.5 Explicitly out of scope for v1 (otherwise idea dies)

Per `Guide.docx:021-022,222-227`: **No** arbitrary FFmpeg filters, keyframed Fusion/Lumetri graph, multicam, nested sequences, live cursors, plugins, unlimited transitions. Also: no live multi-user editing in same working tree. Claim L0-L1 fidelity, not L3.

---

## Stage 2 — End-to-End Architecture

### 2.1 Architecture decision

**V2 direction:** Don't build another NLE. Extend the proven V1 core into a Canonical Timeline Hub + Content-Addressed Asset Layer + NLE Adapter Kit, with VideoGit's Git workflow as the audit/merge layer.

Reuses VideoGit's chosen axes: **A1** Native Git snapshots/ancestry, **B1** conservative TypeScript three-way merge, and **C1** Electron + React with typed IPC. **D1** media CAS + FFmpeg proxy is a V2 addition.

### 2.2 Diagram

```
[NLE A: Premiere] --adapter--> [OTIO / FCP7 XML / AAF / FCPXML import]
[NLE B: Resolve]  --adapter--> [OTIO native]                                \
[NLE C: Final Cut]--adapter--> [FCPXML 1.8]                                  +--> [VideoGit Canonical JSON] --Zod--> [Canonical Store]
              \                                                                     ^  |  stable UUID, integer frames half-open [120,240), NFC, Rational time
               \                                                                    |  |  validated (Guide.docx:071)
                \-- fallback EDL CMX3600 (1 track)                                 |  v
                                                                             [Git: commits/branches/tags/refs/index/merge-base] (A1)
                                                                                   |
                                                                             [SHA-256 CAS Media Store + CFR proxy 1280x720/H264] (D1) <--> S3-swappable
                                                                                   |
                                                                             [PreviewPlan -> HTMLVideo/WebAudio/DOM] == [RenderIR -> allowlisted FFmpeg -> temp->probe->atomic publish]
                                                                                   |
                                                                             [Hub API: Fastify + SQLite WAL jobs/SSE + Pino] <-> [Web App: upload, relink resolver, diff cards, compare players, export chooser]
                                                                                   |
[NLE A/B/C] <--adapter-- [OTIO / XML / AAF / FCPXML export] <-- [Hub Export Compiler] <--+
```

### 2.3 Components (justified)

1.  **Canonical Model** — reuse VideoGit domain types `Engineering_Plan.md:59`: `Project/Sequence/Track/Clip/Caption/AssetReference` + new `AdapterAnnotation` (what was lossy/dropped). Already proven: share one model for edit/diff/merge/preview/export `Guide.docx:017`.
2.  **Adapter Layer** — thin, pure-TS translators. 2026 research: OTIO is the *only* vendor-neutral hub with native Resolve + Premiere 25.6+ beta + Final Cut + Avid preview + Blender ([larryjordan.com], [developer.adobe.com], [github.com/OpenTimelineIO]). Reference impl: `@chatoctopus/timeline` — rational time math `{num,den}` to avoid float drift ([github.com/ChatOctopus/timeline]). Each adapter: `import -> validate -> canonical`, `canonical -> export -> validate`. Never trust NLE output directly.
3.  **Ingest Pipeline** `Guide.docx:063-068`: `Select file -> stream+hash (SHA-256) -> ffprobe validate -> store CAS -> proxy (FFmpeg) -> AssetDescriptor`. Duplicate hash? Skip transcode `Guide.docx:066`. Generated internal names only `Guide.docx:067`. Original immutable `Guide.docx:068`.
4.  **Relink Resolver** (new, critical): Hub stores `SHA-256 + duration + probe metadata`. On export, produce either `REMOTE_URLS` (signed URLs) or `BUNDLE zip` (doc + media) — pattern already used by Videogen `docs.videogen.io:1`. On import, try SHA match -> filename+timecode -> manual resolver UI with side-by-side proxy preview.
5.  **Git Layer** (VideoGit): status/staging/hunks `Guide.docx:093-104`, branch, merge `Guide.docx:125-129`. Enables *cross-NLE merge*: Editor A on Premiere, B on Resolve both edit hub, conservative merge `Guide.docx:132-158`.
6.  **Export Adapters** — compile `RenderIR`/`PreviewPlan` same source `Guide.docx:178-180`. For NLE re-import, compile to best fidelity target supports (Premiere wants FCP7 XML, Resolve prefers OTIO).
7.  **Observability** `Guide.docx:210-211` — Pino correlation ID over project/commit/job/Git cmd/FFmpeg exit; metrics: latency/failure/conflict-rate/stale-ref/cache-hit.

### 2.4 Data model (painful to migrate — freeze early)

```ts
Asset { id, sha256, durationFrames, fps: Rational{num,den}, width, height, codec, proxySha }
Clip { id: UUID, assetId, srcRange: [start,end) frames atomic, trackOrder, gain: enum bounded, preset: enum allowlisted }
Caption { id: UUID, range: [start,end) atomic, text, style: enum allowlisted }
AdapterAnnotation { clipId, field, sourceFormat, fidelity: L0|L1|L2|L3, dropped: boolean, reason }
```

Atomic groups `Guide.docx:083,100` (trim in/out together, caption range together) drive both hunks and loss tracking.

### 2.5 State & storage

*   **Git = source of truth** for timeline (survives SQLite wipe `Guide.docx:058`). Real refs/merge-base/two-parent commits `Engineering_Plan.md:12`.
*   **CAS = media** — one object per SHA, independent of branches/commits `Guide.docx:015`.
*   **SQLite WAL** = only jobs/sessions/locks/caches in single-node first release `Guide.docx:044-045` `Engineering_Plan.md:10`. Not a second history.
*   If cache deleted, rebuild from Git + CAS `Guide.docx:058`.

### 2.6 Boundaries — explicitly NOT owned

Rendering final master (hand off to NLE or Hub FFmpeg proxy only), color plugin graph, cloud storage SLA (abstract behind CAS), org permissions/review approvals until local workflow reliable `Guide.docx:226`.

---

## Stage 3 — Gaps & Fixes

| # | Gap (failure mode) | Evidence | Fix (structurally integrated) | Trade-off |
|---|---|---|---|---|
| 1 | **Fidelity illusion — users expect Lumetri/color/effects to survive** | EDL only cuts, XML/AAF lose effect params across apps [cutconvert.com] | **Tiered fidelity badge in UI:** L0 cuts/timecode ✅, L1 multi-track/speed/markers ✅, L2 captions/transitions limited, L3 effects ❌. Every export emits `lossReport.json` ("Lumetri -> dropped, preset `warm` kept") `Guide.docx:083`. Honesty is USP vs silent drop. | Less "wow" demo, more trust |
| 2 | **Timebase / frame-rate trap** | Float seconds cause "not on edit boundary" [ChatOctopus] | Reuse VideoGit Rational `{num,den}` + `secondsToFrameAligned` snapping [ChatOctopus] + integer frames half-open `Guide.docx:071` + normalize to CFR proxy `Guide.docx:022` | Slight snapping; must document |
| 3 | **Relink hell — missing media** | Absolute paths, reel names, tape names; OTIO clip names revert [community.adobe.com] | **SHA-256 primary key**, fallback filename+duration, manual resolver UI with side-by-side proxy. Never store local paths in versioned JSON `Guide.docx:074`. BUNDLE vs REMOTE_URLS `docs.videogen.io` | Requires upload of media for BUNDLE |
| 4 | **NLE XML dialect fragmentation** | Premiere xmeml v5 != FCPXML 1.8 [cutconvert.com]; Adobe OTIO still beta [community.adobe.com] | **Hub normalizes to OTIO** as interlingua. Support all 3 ingest, use `@chatoctopus/timeline` fixture testing (`tests/fixtures` sweep) [ChatOctopus] | Maintain 3 adapters |
| 5 | **Scale / cost — proxy per branch?** | Branches could duplicate media | CFR 720p proxy once per SHA, CAS dedup means branches don't duplicate `Guide.docx:066,216`; hosted S3/SQS/container `Guide.docx:246` cost linear to unique media | Proxy generation CPU upfront |
| 6 | **Security / abuse — malicious video/XML** | Untrusted upload | Arg arrays, shell disabled, generated paths, URL reject, protocol allowlist, CPU/mem/timeout isolation `Guide.docx:200-204` + XXE-safe XML parsing | Slight overhead |
| 7 | **Redundancy — why not Frame.io/Postlab/Videogen?** | Frame.io = review/storage not editable [frame.io]; Postlab = Premiere-only lock [hedge.video]; Videogen has interchange API but no Git/merge [docs.videogen.io] | **Differentiate:** versioned + branchable + mergeable + diff (`Engineering_Plan.md:94-109` DoD), not one-shot convert | Need to prove merge value |
| 8 | **Silent data loss — no proof** | Converters silently drop | Reuse VideoGit DoD `Engineering_Plan.md:94-109` + `Guide.docx:205-209`: Vitest/fast-check property tests, Playwright clean-merge + conflict workflows from reset seed `Guide.docx:219`, golden render fixture (streams/duration/frame-hashes not byte equality) `Guide.docx:207` | Test investment |

---

## Stage 4 — Rebuilt Architecture & Vertical Slices

### 4.1 Revised slices (keep VideoGit's proven 6 slices `Engineering_Plan.md:74-80` + adapter slice)

1.  **Freeze model + lossReport** — add `AdapterAnnotation` + fidelity tiers L0-L3; canonical JSON serializer, Zod, UUIDs `Guide.docx:071`.
2.  **Prove Git + merge headless** — baseline commit, two branches, independent/conflicting edits, merge-base, two-parent commit. No UI `Engineering_Plan.md:75` `Guide.docx:214-215`.
3.  **Media CAS + proxy + relink resolver** — import hash/probe/dedupe, preview two commits, validated MP4 without duplicating media across branches `Guide.docx:216` `Engineering_Plan.md:76`.
4.  **Adapter slice (NEW, wedge)** — build `Premiere XML <-> Canonical <-> OTIO` first (covers ~80%: Premiere <-> Resolve). Property test: `fixture.xml -> canonical -> export.otio -> canonical` equality on L0. Use real NLE exports in `tests/fixtures` like `ChatOctopus` does. Attach `lossReport` to every translation.
5.  **Edit + commit + history + compare** — timeline UI -> commands -> status (semantic diff `Caption trimmed by 30f` `Guide.docx:095`) -> selective staging (hunk atomic groups `Guide.docx:100`) -> commit (CAS update-ref `Guide.docx:107`) -> branch/checkout/history `Guide.docx:217`.
6.  **Merge + conflict + export chooser** — timeline-aware change cards, synced previews, clean merges, resolver that cannot complete invalid merge `Guide.docx:218` `Engineering_Plan.md:100-102`. Export offers OTIO/XML/AAF/BUNDLE chooser.
7.  **Harden** — cancel/restart recovery `Guide.docx:190-194`, safe exec `Guide.docx:200-204`, demo reset `Guide.docx:195-199`, e2e (Vitest/fast-check/Playwright) `Guide.docx:219`, offline verification.

### 4.2 Key risks -> mitigations (inherits VideoGit `Engineering_Plan.md:84-89`)

*   **Merge correctness** -> pure engine + fast-check (independent/conflicting pairs) + golden fixture.
*   **Media escape / shell injection** -> arg arrays, shell disabled, allowlisted FFmpeg.
*   **Stale client overwrites** -> hunk IDs + CAS branch updates; branch-moved-during-merge -> recompute.
*   **Partial publish** -> temp file + validate before atomic move.
*   **Restart corruption** -> durable job rows, lease reclamation, SQLite TX, Git integrity on boot.

### 4.3 Team ownership (small team `Guide.docx:220-221`)

*   Engineer 1: Git + merge semantics + canonical model
*   Engineer 2: Ingest/preview/export + adapters + FFmpeg/proxy
*   Engineer 3: Editor + workflow + relink/resolver UI
*   Integrate from day 1 against same fixture + shared TS schemas.

### 4.4 What to postpone (moat protection `Guide.docx:222-227`)

Live multi-user same-tree, arbitrary FFmpeg filters/plugins, sophisticated auto-order merge before B1 proven, cloud asset transfer/permissions/review approvals until local workflow reliable, OTIO import/export until internal model stabilized (now adapted: OTIO is *first* for hub).

---

## Stage 5 — USP Pressure-Test & Product Options

### 5.1 Closest alternatives (2026)

*   **OTIO alone + manual zip** — free, but no Git, no SHA dedup, no relink UI, no loss report, rational snapping left to user script.
*   **Frame.io / LucidLink / Postlab** — collaboration/storage/review, not editable cross-NLE timeline portability. Frame.io = 500 file types + Camera-to-Cloud [frame.io]; Postlab = Premiere-only lock [hedge.video].
*   **CutConvert / ChatOctopus / Hedge tools** — one-shot file converters, no version history/merge/audit.

### 5.2 USP Angles — Tiered

#### Tier 1: Structural moat (competitors cannot copy without rewrite)

**USP 1 — "Real Git, not Git-like"** `Engineering_Plan.md:12` `Guide.docx:013`
*   One-liner: Every commit/branch/tag/ref/merge-base/2-parent merge is native Git object that survives restart, works offline, with standard tooling (`git log/blame/reflog`).
*   Beats: Vit AI/custom DAG (loses Git tooling), Postlab cloud, LFS server dep `Engineering_Plan.md:28-30`.
*   Proof: `Engineering_Plan.md:95` DoD + startup Git integrity check `Guide.docx:192`.
*   Robust: SQLite only caches mutable jobs; Git + CAS rebuildable `Guide.docx:058`.

**USP 2 — "Semantic diffs, not JSON blobs"** `Guide.docx:095` `Engineering_Plan.md:18`
*   "Caption trimmed by 30 frames" tied to stable UUID, not `@@ -120 +121 @@`. Enables selective staging `Guide.docx:099`.
*   Beats: Everyone (opaque blobs or nothing).
*   Robust: Same pure TS diff powers status/staging/compare/history/merge `Guide.docx:123`; hunk ID includes index tree + before/after so stale browser cannot stage wrong edit `Guide.docx:103`.

**USP 3 — "Deterministic conservative merge, no magic AI"** `Engineering_Plan.md:17,38` `Guide.docx:130-158`
*   Rules: single-side wins, same-value keep, different-field combine+validate, same-field/order/delete-vs-modify/invalid -> explicit conflict. Full provisional validation after merge.
*   Beats: Vit AI black box (non-deterministic) + Avid bin-lock (pessimistic). Property-based `fast-check` generates pairs `Engineering_Plan.md:85`.
*   Robust: Cannot finish with conflicts/invalid `Guide.docx:161`; abort leaves branch unchanged; CAS `update-ref` prevents stale overwrite `Guide.docx:166,202`.

#### Tier 2: Media & Fidelity (cross-NLE specific)

**USP 4 — "Media outside Git, SHA-256 immutable & deduped"** `Guide.docx:015,063` `Engineering_Plan.md:15`
*   Branch/commit never copies bytes. Stream-hash -> validate -> CAS; dedupe before transcode `Guide.docx:066`.
*   Beats: Git LFS/bundle bloat, NLE project duplication.
*   Robust: Original immutable, new upload = new identity `Guide.docx:068`; missing proxy blocks preview not history `Guide.docx:175`; S3-swappable without history rewrite.

**USP 5 — "One model -> preview == export == merge"** `Guide.docx:017,069-075,168` `Engineering_Plan.md:45,129`
*   Stable UUIDs + integer frames half-open + NFC + sorted keys + canonical UTF-8 `Guide.docx:071` -> same timeline = same state. Gain/preset enum compiles to both WebAudio/CSS and allowlisted FFmpeg `Guide.docx:088`.
*   Beats: Preview drift bugs.
*   Proof: PreviewPlan and RenderIR from same validated state `Engineering_Plan.md:104`.

**USP 6 — "NLE-agnostic, browser-native, offline reproducible"** `Engineering_Plan.md:14,17`
*   Standalone React/Vite + Fastify, no vendor lock; pinned FFmpeg CFR 1280x720/30/H.264 yuv420p [AAC 48k] `Guide.docx:022`; render cache keyed by commit+profile+hashes+renderer `Guide.docx:186`.
*   Beats: Vit Resolve-only, VideoFlow cloud-only.
*   Robust: Full demo succeeds repeatedly offline from seed bundle `Guide.docx:244`.

#### Tier 3: Safety & Operability

**USP 7 — "Atomic safety by construction"** `Guide.docx:200-204` `Engineering_Plan.md:87-89`
*   Arg arrays, shell disabled, generated paths, allowlist, per-project mutex + CAS update-ref, temp->probe->atomic publish.
*   Position: "Audit-ready, not demo-ware."

**USP 8 — "Restart-proof"** `Guide.docx:190-194`

**USP 9 — "Auditability + observable"** `Guide.docx:210-211` — author/UTC + immutable tags + Pino correlation over project/commit/job/Git/FFmpeg.

**USP 10 — "Cross-NLE honest bridge" (NEW for this idea)**
*   *"We tell you what will break before you send."* — lossReport + rational snap + SHA relink vs competitors' silent drops.

### 5.3 Comparison table — product options along this lead

| Option | Description | USP angle (beats alternative) | Moat | Viability | Build order |
|---|---|---|---|---|---|
| **A. Universal Timeline Hub (RECOMMENDED v1)** | Canonical + adapters + BUNDLE/REMOTE_URLS | *One hub, N adapters: edit in your NLE, share without break + keep version history* — beats N×N converters + Postlab lock | Deterministic merge + SHA relink + Git audit | **HIGH** — narrow L0-L1, rides OTIO momentum (Resolve native, Premiere 25.6 beta [dev.adobe.com]) | 1st |
| **B. Git-backed Interchange** | A + branches/tags/merge between NLE origins | *Branch on Premiere, merge from Resolve — conservative 3-way, explicit conflicts, not AI* — beats Vit AI [Engineering_Plan.md:38] | Pure TS merge + fast-check + CAS | Medium — needs both sides on hub | 2nd (after retention) |
| **C. Asset Relink Service** | Standalone: upload any NLE export + media -> relinked project + proxies | *Fixes #1 break: missing media* | SHA CAS + probe metadata vs filename | **HIGH** — sell to post houses today | Wedge alongside A |
| **D. Verified Render Bridge** | Hub FFmpeg validates before publish [Guide.docx:183] -> guarantee playable MP4 per commit | *Preview == export proof* [Engineering_Plan.md:45] | ffprobe+decode vs blind export | Medium | 3rd |
| **E. Template Marketplace Normalizer** | Sellers upload any NLE, hub normalizes to OTIO | Long-tail marketplace moat | Same adapters, catalog network effect | Later | 4th |

**Recommendation:** Start with **A -> C as wedge**, add **B** once A has retention. Never pitch "lossless effects" — pitch *"Cut-accurate, relink-safe, versioned hub with honest loss report."*

---

## Feasibility Assessment

| Dimension | Feasibility | Reason | Mitigation |
|---|---|---|---|
| **Cut list & timecode (L0)** | **HIGH ✅** | OTIO + XML + EDL well-trodden; rational math solves float drift [ChatOctopus] | Use canonical integer frames `Guide.docx:071` |
| **Multi-track, speed, markers, audio gain (L1)** | **HIGH ✅** | Premiere OTIO impl includes cutlist, source in/out, duration, fps, tracks, markers, speed [community.adobe.com]; Videogen API proves FCPXML/PREMIERE_XML/OTIO+SRT interchangeable [docs.videogen.io] | Zod validate + full-project validation after translate |
| **Captions / transitions (L2)** | **MEDIUM ⚠️** | OTIO has gaps/transitions/markers [ChatOctopus]; caption range atomic `Guide.docx:083` but NLEs differ (FCP asset-clip spine) | Map to allowlisted subset `Guide.docx:086-089`; DOM overlay vs FFmpeg burn |
| **Color, Fusion, Lumetri, plugins (L3)** | **LOW ❌ (intentionally)** | Proprietary, non-portable; no standard; AAF even fails sample-rate [forums.steinberg.net] | Explicitly exclude v1 `Guide.docx:222-224`; lossReport |
| **Media relink** | **MEDIUM-HIGH ✅ with CAS** | SHA-256 CAS solves dup + relink primary key `Guide.docx:063`, BUNDLE pattern proven [docs.videogen.io] | Generated paths `Guide.docx:067`, resolver UI |
| **Cross-NLE merge** | **MEDIUM ✅** | Conservative B1 rules `Guide.docx:132-158` proven for timeline; cross-NLE just means two canonical origins | Property tests + conflict resolver `Guide.docx:159-166` |
| **OTIO maturity 2026** | **HIGH ✅ timing** | Resolve native [steakunderwater], Premiere 25.6+ OTIO import/export [dev.adobe.com][community.adobe.com], Final Cut via FCPXML->OTIO [ChatOctopus] | Build on OTIO as hub, not replace |

**Overall Technical Feasibility: VIABLE if scoped to L0-L1 + honest L2.** Lossless universal effects is infeasible for *anyone* — that is why this has not been fixed already.

---

## Viability Assessment

### Market

*   **Demand signal:** Post houses still ask for *all three* (AAF/XML/EDL) per turnover [cutconvert.com] — inefficiency tax. Freelance marketplaces (Fiverr, Upwork) have mixed NLEs. Education growth.
*   **Willingness to pay:** Post teams pay $10-20/seat/mo for Postlab [hedge.video], $ // for LucidLink storage, Frame.io enterprise [frame.io]. A relink-safe hub saves 1h @ $50/h = immediate ROI.
*   **Competition risk:** Adobe/Blackmagic could improve OTIO and obsolete thin converters — but not Git/merge/SHA workflow. Frame.io unlikely to become editable timeline Git. Hedge/Videogen are adjacent not direct.

### Business models along this lead

*   **Freemium local app:** Hub runs single-machine (SQLite + local CAS + one worker) `Engineering_Plan.md:10` — free for <3 projects, paid for team.
*   **Hosted:** Postgres + S3 + SQS + ECS `Guide.docx:246`, OIDC, branch protection — $ per seat + GB.
*   **B2B post house:** Relink Service + verified render — per-project fee.
*   **Marketplace take-rate:** Normalized templates.

### Viability risks

*   **Users expect L3 magic:** Mitigate by tier badge + lossReport.
*   **NLEs break OTIO import next update:** Need fixture CI that sweeps real exports `ChatOptopus tests/fixtures`.
*   **Chicken-egg (both sides need hub):** Wedge C (Relink Service) works with only sender on hub.

### Verdict: **Viable as scoped wedge + expandable to platform.** Timing is favorable (OTIO adoption inflection 2025-26). Do NOT build as "Adobe plugin" — stay NLE-agnostic [Engineering_Plan.md:14].

---

## What We Can Build Along These Lines (Lead Expansion)

All reuse same canonical + CAS + Git + adapters:

1.  **A. Universal Timeline Hub** — core product (v1). Web app: upload (any NLE export + media) -> preview both sides -> diff cards (synced players `Guide.docx:121`) -> export chooser (OTIO/XML/FCPXML/EDL + BUNDLE/REMOTE_URLS). Value: 5-min handoff.
2.  **B. Git-backed Interchange** — same hub + VideoGit workflow: status/staging/commit/branch/compare/merge/resolve `Guide.docx:019` but origins are different NLEs. Value: two editors on different NLEs can branch/merge without lock.
3.  **C. Asset Relink Service** — micro-product: drop NLE project + media folder -> hub probes/hashes/dedupes -> returns fixed project + proxies + relink report. Value: solves #1 break instantly. Can be sold standalone.
4.  **D. Verified Render Bridge** — hub compiles `RenderIR`/`PreviewPlan` from canonical, allowlisted FFmpeg, temp->probe->atomic publish `Guide.docx:178-183`. Value: guaranteed playable MP4 per commit, preview == export.
5.  **E. Conform QA Service** — post house tool: ingest AAF/XML+EDL+reference QT, hub rebuilds timeline, compares against reference (frame hashes), reports mismatch — automates turnover checklist [cutconvert.com].
6.  **F. Template Marketplace Normalizer** — sellers upload in any NLE, hub normalizes to OTIO for buyers; buyers re-export to their NLE. Value: expands TAM.
7.  **G. Programmatic Video CI/CD** — headless `canonical -> MP4` via Git commit hook, like VideoFlow's VideoJSON Git workflow [videoflow.dev] but cross-NLE. Value: SaaS that auto-renders personalized videos.

---

## Implementation Plan

### Architecture map (reuse VideoGit `Engineering_Plan.md:57-68`)

*   **Domain model** (`types`, Zod, canonical JSON serializer, UUIDs, Rational frames) — shared everywhere; add `AdapterAnnotation` + `FidelityTier`.
*   **Adapters** (`adapters/otio`, `adapters/xmeml`, `adapters/fcpxml`, `adapters/edl`) — pure TS, rational time, Zod.
*   **Git service** (Node `child_process.spawn` arg arrays, CAS ref updates, merge-base, two-parent commit) — unchanged `Engineering_Plan.md:60`.
*   **Media store** (SHA-256 CAS, proxy gen via FFmpeg/ffprobe, dedupe, immutable originals) `Engineering_Plan.md:61`.
*   **Semantic diff engine** (pure TS; powers status, staging, compare, merge-preview) `Engineering_Plan.md:62`.
*   **Three-way merge engine** (pure TS; B1 rules; conflict model) `Engineering_Plan.md:63`.
*   **Command/reducer layer** (edit commands -> validated model; workspace version guard) `Engineering_Plan.md:64`.
*   **API** (Fastify: import, status, stage, commit, branch, checkout, history, compare, merge, export, SSE progress + new: `/translate`, `/relink`, `/lossReport`) `Engineering_Plan.md:65`.
*   **Web app** (React timeline, caption overlay, conflict resolver, history graph, compare view + new: relink resolver, export chooser, fidelity badges) `Engineering_Plan.md:66`.
*   **Job worker** (SQLite WAL leases, FFmpeg spawn, SSE, cancel/retry, recovery) `Engineering_Plan.md:67`.
*   **Recovery/observability** (startup reconcile, Pino correlation IDs, metrics) `Engineering_Plan.md:68`.

### Build sequence (vertical slices — inherits `Engineering_Plan.md:72-80` + `Guide.docx:212-219`)

| Slice | Goal | VideoGit DoD proven |
|---|---|---|
| **S0 Freeze model** | Stable IDs, frame rules, canonical serialization + AdapterAnnotation/LossReport; prove same logical timeline -> same state `Guide.docx:214` | `Engineering_Plan.md:97` |
| **S1 Git+merge headless** | Baseline commit, 2 branches, independent/conflicting edits, merge-base, 2-parent commit — no UI `Guide.docx:215` | `Engineering_Plan.md:98-102` |
| **S2 Media pipeline** | Imports, hash/probe/proxy, preview 2 commits, validated export, no dup across branches `Guide.docx:216` | `Engineering_Plan.md:96,105` |
| **S3 Adapter slice (NEW)** | `Premiere XML <-> Canonical <-> OTIO` + EDL fallback; fixture sweep (real exports) + property tests; lossReport per translation | New |
| **S4 Edit+commit workflow** | UI -> commands, status, selective stage, commit, branch, checkout, history + relink resolver `Guide.docx:217` | `Engineering_Plan.md:97,99` |
| **S5 Compare + conflict** | Timeline-aware change cards, synced previews, clean merge + resolver that can't finish invalid `Guide.docx:218` | `Engineering_Plan.md:98-102` |
| **S6 Harden + demo** | Cancel/restart recovery, safe exec, demo reset (seed bundle) `Guide.docx:195-199`, e2e Vitest/fast-check/Playwright `Guide.docx:219`, offline verification `Guide.docx:219` | `Engineering_Plan.md:106-109` |

### Testing strategy `Guide.docx:205-209`

*   Pure domain: canonical serialization, Rational arithmetic, semantic diff, 3-way merge. Use `fast-check` to generate independent/conflicting edit pairs + adapter round-trips.
*   Git integration: temp repos, real OTIO/XML fixtures (`tests/fixtures/` like ChatOctopus).
*   Render: synthetic fixtures through FFmpeg; golden fixture checks streams/duration/frame-hashes not byte equality.
*   Browser: Playwright clean-merge + conflict-resolution + translate (Premiere->Resolve) journeys from reset seed.

### Infra evolution `Guide.docx:245-246`

*   v1: single machine, local CAS, SQLite WAL, one worker, pinned FFmpeg.
*   Hosted: keep same Git/timeline semantics, replace local infra: PostgreSQL (operational state), S3 (media/renders), SQS (jobs), container workers ECS, OIDC, branch protection.

---

## Open Questions (Decisions Before Build)

1.  **Primary persona for v1?** Freelance hopper (optimize one-shot translate + relink) vs post team (optimize branch/merge across NLEs) — determines first marketing + slice priority.
2.  **Fidelity tier lock:** Confirm L0-L1 only for v1 (cuts/timecode/multi-track/speed/markers/gain/preset enum) — defer L3 effects/plugins. Impacts allowlist `Engineering_Plan.md:116`.
3.  **Adapter order:** `Premiere XML + OTIO` first (covers ~80%: Premiere <-> Resolve) vs include `FCPXML 1.8` day-1? Impacts ChatOctopus/FCPXML reader complexity (containers skipped [ChatOctopus]).
4.  **Media delivery default:** `BUNDLE zip` (durable offline, heavy) vs `REMOTE_URLS` (light, needs signed URLs) [docs.videogen.io] — impacts CAS/S3 design + UX.
5.  **Single local worker vs queue abstraction day-1?** Guide says single-node first but abstract boundary now `Engineering_Plan.md:115` + `Guide.docx:246` hosted evolution — decision affects job worker interface.
6.  **Demo seed repo format:** Git bundle vs scripted fixture `Engineering_Plan.md:117` — needed for Playwright tests + offline demo `Guide.docx:195-199`.
7.  **Scope of "visual preset" enum `Engineering_Plan.md:116`:** lock allowlist early — drives both preview CSS and FFmpeg filter compiler + adapter loss mapping.
8.  **AAF priority:** Defer AAF binary (Avid/ProTools audio post) to v1.1 to avoid early complexity, or include for post-house sales?

> **Next step:** Confirm 1-3, then draft `PLAN.md` with file map, API contracts (`/translate`, `/relink`), Zod schemas, and task breakdown. No code until plan approved.

---

## References

*   `VideoGit_Feature_Implementation_Guide.docx:001-251` — core workflow, editing/Git/preview/export features, safety, DoD.
*   `VideoGit_Engineering_Plan.md:1-132` — axes A1/B1/C1/D1, component map, build sequence, USP appendix.
*   OTIO support 2026: [Larry Jordan — OTIO now supported on Final Cut/Premiere/Resolve](https://larryjordan.com/articles/opentimelineio-now-supported-on-final-cut-premiere-and-resolve/) , [Adobe — Reframe OTIO 25.6+](https://developer.adobe.com/audio-video-firefly-services/guides/otio/) , [Adobe Community — OTIO beta](https://community.adobe.com/questions-729/opentimelineio-otio-export-option-missing-in-premiere-pro-s-export-menu-1418570) , [ASWF — OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)
*   Interchange pain: [CutConvert — EDL vs XML vs AAF](https://cutconvert.com/guides/edl-vs-xml-vs-aaf) , [Cutsio — EDL guide](https://cutsio.com/blog/how-to-export-edl-from-davinci-resolve) , [Steinberg — AAF/OMF problems](https://forums.steinberg.net/t/aaf-and-omf-problems/723932)
*   Adapter reference: [ChatOctopus/timeline — FCPXML/xmeml/OTIO with rational time](https://github.com/ChatOctopus/timeline) , [DaVinci Resolve OTIO manual](https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part4003.htm)
*   Vendor patterns: [Frame.io workflows](https://frame.io/enterprise/video-workflows) , [PostLab — Premiere-only collaboration](https://docs.hedge.video/postlab) , [Videogen — timeline-interchange API (FCPXML/PREMIERE_XML/OTIO/SRT, REMOTE_URLS/BUNDLE)](https://docs.videogen.io/rest-api-reference/projects/create-timeline-interchange.md) , [VideoFlow — VideoJSON Git version control](https://videoflow.dev/blog/video-version-control-git-timelines)

---

## Appendix — VideoGit USP Angles (Robustness)

*Inherited from `Engineering_Plan.md:121-132` positioning reference:*

1.  **"Git, but for your timeline."** — mental model for technical creators.
2.  **Semantic diffs, not opaque blobs.** — *Caption trimmed by 30 frames.*
3.  **Merge like developer, not lock.** — base/ours/theirs vs Avid bin-lock / Postlab manual.
4.  **NLE-agnostic & browser-native.** — vs Vit (Resolve-only) / Postlab (Premiere-only).
5.  **Media outside Git, immutable & deduped.** — no repo bloat.
6.  **Deterministic, provable merge (no AI black box).** — vs Vit.
7.  **One timeline model -> preview == export == merge.**
8.  **Offline, local-first, reproducible.**
9.  **Auditability for agencies/legal** (commit+author+UTC+tags).
10. **Reproducible renders via content-addressed cache.**
11. **(Added for Hub) Honest cross-NLE bridge** — lossReport + SHA relink vs silent break.

*DoD per `Engineering_Plan.md:94-109` and `Guide.docx:228-244`: real Git objects survive restart, media immutable/CAS, commit/staged/working distinct, every edit has semantic change, independent edits merge, conflicting edits become explicit conflicts, merge blocked while invalid, abort unchanged, stale client blocked, checkout refuses to destroy work, preview/export from same state, MP4 passes ffprobe+decode, cancel/restart safe, tests cover serialization/diff/merge/Git/media/output, browser tests both merge paths, full demo succeeds offline.*
