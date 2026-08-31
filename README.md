# SnipSnap

SnipSnap is Git-style version control for video-editing timelines. You keep editing in DaVinci
Resolve or Kdenlive; SnipSnap watches the saved timeline, explains what changed in editing terms,
and lets you stage, commit, branch, compare, and merge those decisions.

It answers questions that ordinary project files do not answer well:

- What clips moved, were added, deleted, trimmed, slipped, or split?
- Which changes belong in the next saved revision?
- What did this branch change from the original cut?
- Can two edits be combined safely, and where do they conflict?
- What did an older commit look like using the media available on this computer?

SnipSnap is not a video editor. It does not replace Resolve or Kdenlive, and it never puts footage
inside Git. Git stores small, deterministic timeline snapshots; local media paths and footage stay
outside the repository. VideoGit

## What works today

### Editor save tracking

- **Kdenlive:** connect a native `.kdenlive` project once. While SnipSnap is running, every valid
  **Ctrl+S** save is detected, converted to SnipSnap's timeline model, and shown as new working
  changes. A same-name `.otio` handoff is regenerated automatically.
- **DaVinci Resolve:** connect a detected Resolve project and start save sync, or watch a manually
  exported `.otio` file. A saved editor state becomes the timeline SnipSnap compares.
- Track folders containing Kdenlive projects or Resolve `.drp` and `.otio` exports from the project
  dashboard.
- Stable identity reconciliation prevents normal editor rewrites from appearing as unrelated
  delete/add noise.

### Useful timeline diffs

SnipSnap reports changes as editing operations rather than raw JSON:

- clip additions, deletions, moves, trims, slips, splits, and joins;
- track order and timeline structure;
- gaps, transitions, captions, markers, names, enabled state, colour labels, audio gain, and the
  supported preview looks;
- preserved editor metadata and unsupported-content warnings.

Bookkeeping that must stay together is kept inside one stageable change. For example, moving a clip
does not also flood the panel with separate gap updates. A linked video move and audio move remain
separately stageable, while duplicate internal audio streams are grouped into the audio change.

### Real Git history

- Separate committed, staged, and working timeline states.
- Stage one semantic change or all changes, then commit a complete validated snapshot.
- Create and switch branches, including branches from historical commits.
- Tag commits, inspect history, view the commit graph, and compare any two revisions.
- Merge branches with conservative three-way timeline merging.
- Resolve explicit conflicts for competing edits; invalid or unresolved merges cannot complete.
- Export any immutable commit to OpenTimelineIO.

The underlying project repository contains normal Git objects, commits, parents, refs, branches,
and tags. SnipSnap performs timeline-aware staging and merging itself; Git never text-merges the
timeline file.

### Preview and local collaboration

- Preview an immutable commit from media linked on the current computer.
- Compare revisions with a shared playhead and timeline view.
- Relink missing footage without changing committed history.
- Host a project to another SnipSnap computer on the same local network.
- Pull and push Git history and transfer missing media outside Git in encrypted, resumable,
  hash-verified chunks.

Local-network collaboration is intentionally limited: both computers must be directly reachable.
There are no hosted accounts, public repositories, access roles, pull requests, internet relays, or
NAT traversal yet.

## Typical workflow

```text
Edit in Resolve or Kdenlive
        ↓ save
SnipSnap detects the saved timeline
        ↓
Review semantic changes
        ↓
Stage selected editing decisions
        ↓
Commit → branch → compare → merge → export
```

1. Connect a Resolve project or native Kdenlive project from the dashboard.
2. Edit in the NLE and save.
3. Review the **Changes** panel in SnipSnap.
4. Stage the changes that belong together and write a commit message.
5. Create branches for alternate cuts, compare revisions, or merge completed work.
6. Select a commit to preview it or export its immutable OTIO handoff.

## Requirements

For development and running from source:

- Git 2.x on `PATH`;
- Node.js **22.22.0** (pinned in `snipsnap/.mise.toml`);
- npm;
- [mise](https://mise.jdx.dev/) is recommended for selecting the pinned Node version.

For editor integrations:

- Kdenlive for native Kdenlive save tracking;
- DaVinci Resolve and Python 3 for managed Resolve save sync.

You can develop and run the automated tests without either editor or real footage. Avoid Node 26
for packaging: Electron Forge can exit early under it in this project.

## Install and run from source

Clone the repository, then run the application from `snipsnap/`.

### Linux and macOS

```bash
git clone https://github.com/Nainikap/WhamBamVITShazam.git
cd WhamBamVITShazam/snipsnap
mise install
mise exec -- npm ci
mise exec -- npm start
```

### Windows PowerShell

```powershell
git clone https://github.com/Nainikap/WhamBamVITShazam.git
Set-Location WhamBamVITShazam\snipsnap
mise install
mise exec -- npm ci
mise exec -- npm start
```

If you use another Node version manager, select Node 22.22.0 and remove `mise exec --` from the npm
commands:

```bash
npm ci
npm start
```

After the first install, the normal development command is:

```bash
cd snipsnap
mise exec -- npm start
```

The Electron window opens automatically. The terminal process stays active until the app closes or
you press **Ctrl+C**.

## Build a desktop package

Run these commands on the operating system you want to package for:

```bash
cd snipsnap
mise exec -- npm run package  # unpacked application under out/
mise exec -- npm run make     # distributable for the current operating system
```

Electron Forge is configured for Windows Squirrel, macOS ZIP, Debian, and RPM outputs. These are
native builds; this repository does not claim that one operating system can produce every other
platform's installer.

## Connect Kdenlive

1. Open SnipSnap and choose **Connect Kdenlive**.
2. Select the native `.kdenlive` project. To discover several projects, choose **Track Kdenlive
   folder** instead.
3. Keep editing in Kdenlive and press **Ctrl+S** normally.
4. SnipSnap updates the working timeline automatically and shows semantic changes immediately.
5. Stage and commit the changes you want to keep.

To open an older SnipSnap revision in Kdenlive:

1. Select the commit in SnipSnap.
2. Choose **Prepare for Kdenlive**.
3. In Kdenlive choose **File > OpenTimelineIO Import** and select the prepared `.otio` file.

SnipSnap launches Kdenlive without passing the OTIO as a normal document because Kdenlive otherwise
adds it as a bin clip instead of importing its timeline. See the
[Kdenlive integration guide](docs/KDENLIVE_INTEGRATION.md) for supported data and fidelity limits.

## Connect DaVinci Resolve

### Managed save sync

1. In Resolve open **Preferences > System > General** and set **External scripting using** to
   **Local**.
2. Open a Resolve project with a timeline and save it once.
3. In SnipSnap select the detected project and choose **Start save sync**.
4. Edit and save in Resolve. SnipSnap receives the latest saved timeline state.
5. Review, stage, and commit the changes in SnipSnap.

SnipSnap observes saved state; it does not commit every keystroke or create commits automatically.

### Export fallback

If external scripting is unavailable, export a `.drp` and `.otio` beside each other and use
**Track Resolve folder**, or connect the OTIO file directly from an existing project. SnipSnap also
ships a Resolve menu script that can export the open project and its timelines. Installation and
manual commands are documented in [resolve/README.md](resolve/README.md).

## Media and preview behavior

Each commit stores timeline decisions, not a rendered video. The preview player reads original media
through machine-local links:

- use **Locate media** when footage is missing;
- media links stay in local application data and never alter Git history;
- MP4, MOV, WebM, and common audio files work when packaged Chromium supports their codec;
- previews approximate portable timeline choices and do not reproduce arbitrary Resolve Color,
  Fusion, Kdenlive effect, or third-party plugin output.

Editor-native project files remain untouched. Kdenlive effects, compositions, subtitles, nested
sequences, generators, and speed effects remain in the `.kdenlive` file but are not claimed as
portable timeline data. Resolve Color graphs, Fusion graphs, and plugin state are likewise not
portable through OTIO.

## Local-network collaboration

On the computer that owns the project:

1. Open the project and choose **Host this project**.
2. Send the pairing code to the collaborator over a trusted channel.
3. Keep SnipSnap open during joins, pulls, and pushes.

On the collaborator's computer:

1. Choose **Join** and enter the pairing code.
2. SnipSnap imports the advertised branches, tags, and commits.
3. Missing media downloads outside Git and is verified before publication.
4. Commit on a branch and push the history back to the host.

This is a same-network workflow, not a hosted GitHub-style service. The proposed hosted architecture
is described in [the hosted collaboration plan](docs/HOSTED_COLLABORATION_PLAN.md).

## Platform notes

Kdenlive discovery checks common Linux, macOS, and Windows install locations and then `PATH`. Set
`SNIPSNAP_KDENLIVE_BINARY` to the full executable path for portable or custom installations.

Resolve discovery follows common application-data, project-library, and Scripts locations on all
three platforms. Advanced overrides are available:

- `SNIPSNAP_RESOLVE_ROOT`
- `SNIPSNAP_RESOLVE_DATABASE`
- `SNIPSNAP_RESOLVE_SCRIPTS`
- `SNIPSNAP_RESOLVE_SCAN`

The application's own local data is stored below Electron's per-user SnipSnap data directory. Test
and end-to-end runs use temporary data roots and do not modify the normal project list.

## Architecture and security

```text
React renderer
  → typed, context-isolated preload API
  → Electron IPC
  → application services
  → semantic timeline model / native Git / local sidecar state
```

- The renderer is sandboxed, with Node integration disabled and context isolation enabled.
- Filesystem, process, Git, cryptography, Python, and Electron APIs stay in the main process.
- Git subprocesses use argument arrays without a command shell.
- Project mutations are serialized and refs use compare-and-swap updates.
- Application state and generated handoffs use atomic replacement.
- Machine-local paths remain outside committed snapshots.

## Repository layout

```text
docs/                      Product, integration, architecture, and planning documents
resolve/                   Resolve export and save-sync scripts
snipsnap/                  Electron application
  src/domain/              Validated canonical timeline model
  src/adapters/            Resolve OTIO and native Kdenlive adapters
  src/diff/                Semantic diff and staging
  src/merge/               Timeline-aware three-way merge
  src/git/                 Native Git object and ref operations
  src/application/         Project, editor sync, preview, and collaboration services
  src/ipc/                 Typed main/preload/renderer contract
  src/renderer/            React and Zustand interface
  tests/                   Unit, integration, and packaged Electron tests
```

## Verify a change

Run the complete local gate from `snipsnap/`:

```bash
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm test
mise exec -- npm run test:integration
mise exec -- npm run build
mise exec -- npm run package
```

For UI, IPC, preview, editor-sync, or collaboration changes, also run:

```bash
mise exec -- npm run test:e2e
```

The automated suites use temporary Git repositories and synthetic or sanitized fixtures. They do
not require personal footage or a user's Git configuration.

## More documentation

- [Kdenlive integration and fidelity](docs/KDENLIVE_INTEGRATION.md)
- [Resolve integration scripts](resolve/README.md)
- [Hosted collaboration plan](docs/HOSTED_COLLABORATION_PLAN.md)
- [Documentation index](docs/README.md)
- [Contributor handoff](docs/HANDOFF.md)
