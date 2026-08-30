# SnipSnap / VideoGit

SnipSnap is a local-first Electron application that brings Git-style version control to
DaVinci Resolve and Kdenlive timelines. The NLE remains the video editor. SnipSnap observes saved
timeline state, converts the supported OTIO data into a deterministic canonical model, and provides
semantic changes, staging, commits, branches, history, comparisons, conservative merges, and
historical preview.

The important boundary is:

```text
Resolve save or Kdenlive OTIO export
        |
        v
Editor OTIO/save adapter
        |
        v
Canonical timeline JSON ---- semantic diff / stage / merge
        |                                      |
        v                                      v
Native Git commits and refs            Electron review UI
        |
        v
Immutable commit preview and OTIO export
```

SnipSnap does **not** edit video inside the app. It versions editing decisions made in Resolve.
Footage is never committed to Git.

## Current status

The Resolve V1/V1.5 workflow and a bounded Kdenlive OTIO V2 slice are implemented with real
application services and real Git objects; this is not a mock UI. The current tree also includes a
bounded LAN collaboration demo that transfers Git history and missing media between two SnipSnap
computers on the same network.

Implemented:

- deterministic, validated canonical timeline snapshots with stable UUIDs, rational frame rates,
  integer half-open frame ranges, NFC strings, and canonical JSON;
- OTIO import/export for the supported Resolve subset, including clips, gaps, transitions,
  tracks, markers, effects, enabled state, colour labels, and SnipSnap caption metadata;
- distinct `HEAD`, semantic `INDEX`, and `WORKING` snapshots;
- human-readable semantic changes with atomic staging and stale-state checks;
- native Git commits, branches, tags, history, merge bases, annotated tags, and two-parent merges;
- branch creation from an old commit, guarded checkout, restore-to-working, and immutable export;
- conservative three-way merges with explicit same-field, delete/modify, order, and validation
  conflicts;
- commit history and graph, per-commit semantic diff disclosure, individual-diff focus, and
  side-by-side commit comparison;
- preview from locally linked browser-compatible media, including multi-track video compositing,
  captions, audio level, and the small portable preset allowlist;
- save-driven Resolve synchronization plus manual OTIO watching as a fallback;
- Kdenlive OTIO import/watch, stable-ID reconciliation, immutable commit handoff, native app launch,
  and a machine-readable fidelity report beside every handoff;
- same-LAN host/join/pull/push using Git bundles and encrypted, resumable, SHA-256-verified media
  chunks.

Not implemented:

- in-app timeline or video editing;
- native `.kdenlive`/MLT parsing, automatic Kdenlive save capture, or proprietary effect conversion;
- portable Resolve Color-page nodes, Fusion graphs, third-party plugins, or arbitrary effects;
- FFmpeg proxy generation, verified per-commit renders, or a production media cloud;
- internet discovery, NAT traversal, relay servers, hosted accounts, permissions, or pull requests.

See [the implementation status](docs/V1_IMPLEMENTATION_STATUS.md) for requirement-to-test
traceability and the remaining live-Resolve validation gate. The authoritative V1 contract is
[the Engineering Plan](docs/VideoGit_Engineering_Plan.md); the cross-NLE document is research, not
current product behavior.

## Architecture

```text
React + Zustand renderer
  -> typed context-isolated preload API
  -> Electron IPC handlers
  -> ProjectService and focused application services
  -> canonical model / OTIO / semantic diff / merge / native Git / sidecar state
```

Security boundaries are intentional:

- `nodeIntegration` is disabled, `contextIsolation` is enabled, and the renderer is sandboxed;
- filesystem, Git, cryptography, Python, and Electron APIs stay in the main process;
- Git commands use `spawn` with argument arrays and `shell: false`;
- branch/ref inputs are validated and branch refs move with expected-old compare-and-swap;
- application state uses temporary-file-plus-rename publication;
- local media paths live in untracked sidecar state and are exposed through a restricted custom
  media protocol rather than arbitrary renderer filesystem access.

Git stores one complete canonical `timeline.json` snapshot per commit. SnipSnap computes semantic
diffs, staging, and three-way merges in TypeScript; Git never text-merges the timeline.

## Repository layout

```text
AGENTS.md                  Repository rules and invariant checklist
docs/                      Product contract, architecture, status, and design system
resolve/                   Resolve export/save bridge scripts and fake-Resolve harness
snipsnap/                  Electron Forge application
  src/domain/              Canonical model, validation, frame math, serialization
  src/adapters/otio/       Pure OTIO import/export adapter
  src/adapters/kdenlive/   Kdenlive capability and fidelity-report adapter
  src/diff/                Semantic diff and atomic hunk application
  src/merge/               Conservative three-way merge and conflict descriptions
  src/git/                 Native Git process and repository primitives
  src/application/         Project, Resolve, preview-media, and LAN orchestration
  src/ipc/                 Shared typed IPC contract
  src/renderer/            React UI and Zustand workflow state
  tests/                   Unit, property, Git integration, Resolve-contract, and E2E tests
```

The WebGPU prism used on the intro/library screen is vendored under its own MIT notice in
`snipsnap/src/renderer/prism/hero/`. It is presentation code, not part of timeline semantics.

## Prerequisites

- Git 2.x available on `PATH`;
- Node.js 22.22.0, pinned by `snipsnap/.mise.toml`;
- npm;
- Python 3 for Resolve companion scripts;
- DaVinci Resolve for the real editor workflow. Most automated tests use fixtures and do not
  require Resolve or real footage.
- Kdenlive 26.04 or newer for the Kdenlive workflow; SnipSnap also searches standard Windows and
  Linux install locations and accepts `SNIPSNAP_KDENLIVE_BINARY` as an override.

Electron Forge 7 is known to exit early under Node 26. Use the pinned Node version for packaging
and release verification.

## Install and run

From the repository root:

```bash
cd snipsnap
mise install
mise exec -- npm ci
mise exec -- npm start
```

If `mise` is unavailable, install Node 22.22.0 by another version manager and run the same npm
commands without the `mise exec --` prefix.

Runtime data is stored under Electron's `userData/v1-data` directory. Tests and E2E runs override
that root so they do not touch normal project data.

## Connect DaVinci Resolve

### Managed save sync

1. In Resolve, enable **Preferences > System > General > External scripting using: Local**.
2. Open or create a Resolve project with a timeline and save it once.
3. Start SnipSnap and open the detected project from the dashboard.
4. Press **Start save sync** in the project screen.
5. Edit in Resolve and save the Resolve project.
6. SnipSnap receives the newest saved OTIO snapshot as `WORKING`. It does not create a commit.
7. Review the semantic changes, stage the intended hunks, enter a message, and commit.

The managed bridge observes Resolve's persisted save marker. It does not commit each edit and it
does not queue every save. The UI always shows the cumulative semantic difference from the current
commit/index to the newest working snapshot.

### Script export and manual fallback

`resolve/SnipSnapSync.py` exports a `.drp`, one `.otio` per timeline, and `manifest.json`. The app
can install the script beside `resolve_connection.py` in Resolve's Scripts menu. It can also scan a
folder containing a `.drp` beside its `.otio`, or connect directly to a manually exported OTIO
file.

Detailed script commands and install locations are in [resolve/README.md](resolve/README.md).

## Connect Kdenlive

Kdenlive 26.04 supports OpenTimelineIO import/export for multiple tracks, clips, and markers.
SnipSnap uses that supported boundary rather than writing Kdenlive's versioned MLT project format.

1. In Kdenlive choose **File > OpenTimelineIO Export** and save an `.otio` file.
2. In SnipSnap choose **Import Kdenlive OTIO** (or **Kdenlive** from a populated dashboard).
3. Continue editing in Kdenlive. Export back to the same `.otio` path when you want SnipSnap to
   detect the next saved timeline state.
4. Review, apply, stage, and commit the semantic changes in SnipSnap.
5. Select any immutable commit and choose **Prepare for Kdenlive**. SnipSnap atomically writes the
   OTIO handoff plus `<commit>.report.json`, copies the path, reveals the file, and launches Kdenlive.
   In Kdenlive choose **File > OpenTimelineIO Import** and paste/select that handoff.

Portable cuts, tracks, gaps, source ranges, media references, and markers are supported. Marker
instance semantics, transitions, audio gain, disabled state, and colour labels are best-effort.
Captions, arbitrary effects, generators, SnipSnap preview looks, Resolve Color/Fusion graphs, and
editor-specific metadata are reported rather than falsely presented as editable cross-NLE state.
See [the Kdenlive integration guide](docs/KDENLIVE_INTEGRATION.md) for the complete fidelity table.

### What changes are detected?

SnipSnap is not limited to clip cuts. The semantic model can report clip additions/deletions,
blade cuts, trims, slips, track/item order, source media, names, audio gain, the portable look
preset, colour labels, gaps, transitions, captions, markers, enabled state, effects, and preserved
editor metadata. Related structural edits are grouped when they must stage together to remain a
valid timeline.

Detection is limited by what Resolve writes into OTIO or exposes through the supported database
fallback. Resolve's complete Color/Fusion/plugin state is not portable OTIO data and is therefore
not honestly versioned as an editable cross-editor effect.

## Commit, branch, compare, and merge workflow

1. Save an edit in Resolve and review **Unstaged** changes in the left source-control panel.
2. Stage individual semantic changes or use **Stage all**.
3. Commit the validated index snapshot. Only staged decisions enter the commit.
4. Click a commit in **Commits** to select it. Clicking the selected commit again closes its diff
   disclosure.
5. Choose **All changes** to compare the full commit with its parent, or choose one disclosed
   semantic change to focus the comparison on that edit.
6. Use **Create** under Branch to create and switch to a branch at the selected historical commit.
7. Switch branches only with a clean workspace, or explicitly confirm discarding pending state.
8. Merge another branch into the checked-out branch. Independent fields combine; ambiguous edits
   open the conflict resolver. A merge cannot complete while conflicts or validation errors remain.

Selecting an old commit only previews it. To continue editing from it in Resolve, create a branch
at that commit, export that immutable revision to OTIO, then import/open that timeline in Resolve.

## Historical preview and diffs

Every commit stores canonical timeline state, not a rendered video. SnipSnap builds a preview plan
from the selected immutable commit and plays source ranges from locally linked media.

- If media is missing, use **Locate media**. The path stays in `media-links.json`, outside Git.
- Browser-compatible MP4/MOV/WebM and common audio containers are the intended preview path;
  codec support is whatever the packaged Chromium build can decode.
- The side-by-side viewer shares a playhead and stops both players at the shorter revision, avoiding
  endless buffering after one comparison side ends.
- Preview is an editorial approximation. Unsupported Resolve effects may not look like the Resolve
  render. Exported OTIO and future verified renders are separate concerns.

## LAN collaboration demo

On the computer holding the project and footage:

1. Open the project and choose **Host this project**.
2. Send the pairing code to the other SnipSnap user over a trusted channel.
3. Keep SnipSnap open while the peer joins, pulls, or pushes.

On the other computer:

1. Choose **Join** on the dashboard and paste the pairing code.
2. SnipSnap imports all advertised branches/tags/commits from a Git bundle.
3. Missing media downloads outside Git in resumable 8 MiB chunks and is hash-verified before
   atomic publication.
4. Commit on a branch and push it back; the host validates the expected remote head before moving
   the branch.

This is an MVP LAN transport, not GitHub hosting. Both computers must be directly reachable on the
same network. There is no relay/NAT traversal, user account system, background daemon, or proxy
generation. Push currently sends repository history; it does not upload newly introduced peer
media back to the host.

## Platform notes

Electron Forge creates native Windows, Debian, and RPM packages. Linux Resolve discovery follows
`$XDG_DATA_HOME` (falling back to `~/.local/share`) for SnipSnap exports, Resolve project libraries,
and user scripts, with `/opt/resolve` as the system script location. Environment overrides remain
available through `SNIPSNAP_RESOLVE_ROOT`, `SNIPSNAP_RESOLVE_DATABASE`,
`SNIPSNAP_RESOLVE_SCRIPTS`, and `SNIPSNAP_RESOLVE_SCAN`.

Kdenlive launch discovery covers `/usr/bin`, `/usr/local/bin`, the macOS application bundle, and
standard Windows Program Files/local-app installs. Set `SNIPSNAP_KDENLIVE_BINARY` for portable or
custom installations. Kdenlive does not expose its OpenTimelineIO importer as a command-line option;
passing `.otio` as the document argument incorrectly adds it as a bin clip, so SnipSnap deliberately
uses the explicit in-app import step. Native MLT support may be added later for Kdenlive-only
fidelity, but MLT must not replace canonical JSON as Git source of truth.

## Verification

Run the full local gate from `snipsnap/`:

```bash
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm test
mise exec -- npm run test:integration
mise exec -- npm run build
mise exec -- npm run package
```

Run packaged Electron journeys separately when changing UI, IPC, preview, Resolve integration, or
collaboration:

```bash
mise exec -- npm run test:e2e
```

The suites use temporary repositories, synthetic/sanitized OTIO fixtures, and a fake Resolve
contract harness. They do not replace the manual real-Resolve/real-codec gate documented in
[V1_IMPLEMENTATION_STATUS.md](docs/V1_IMPLEMENTATION_STATUS.md).

## Documentation map

1. [Engineering Plan](docs/VideoGit_Engineering_Plan.md) - authoritative V1/V1.5 contract.
2. [System Architecture](docs/VideoGit_System_Architecture_V1_V2.md) - V1-to-V2 roadmap.
3. [Cross-NLE Universal Hub](docs/VideoGit_CrossNLE_Universal_Hub_Brainstorm.md) - future research.
4. [Implementation Status](docs/V1_IMPLEMENTATION_STATUS.md) - current evidence and manual gates.
5. [Kdenlive Integration](docs/KDENLIVE_INTEGRATION.md) - OTIO workflow and fidelity contract.
6. [Hosted Collaboration Plan](docs/HOSTED_COLLABORATION_PLAN.md) - reasoned future GitHub-style architecture.
7. [Studio Graphite Design System](docs/SnipSnap_Studio_Graphite_Design_System.md) - UI guardrails.
8. [Project handoff](docs/HANDOFF.md) - context for continuing in a fresh agent/Linux session.
