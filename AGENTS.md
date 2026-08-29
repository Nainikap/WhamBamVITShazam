# SnipSnap / VideoGit repository guide

This repository implements the VideoGit V1 product described in `docs/`. The Electron
application currently lives in `snipsnap/`. Read this file and `docs/README.md` before
making changes.

## Source of truth and scope

Documentation precedence is strict:

1. `docs/VideoGit_Engineering_Plan.md` is the authoritative V1 contract.
2. `docs/VideoGit_System_Architecture_V1_V2.md` explains the V1-to-V2 architecture but
   cannot add requirements that conflict with the Engineering Plan.
3. `docs/VideoGit_CrossNLE_Universal_Hub_Brainstorm.md` is future research only.

V1 is a local Electron desktop application using this process boundary:

```text
React renderer -> typed context-isolated preload IPC -> Electron main -> application services
```

Node, Electron, filesystem, cryptography, and child-process APIs belong only in the main
process. Keep `nodeIntegration` disabled, `contextIsolation` enabled, and the renderer
sandboxed. Do not add a localhost HTTP server to V1.

V1 includes:

- a validated canonical timeline model with stable UUIDs, rational frame rates, integer
  half-open frame ranges, NFC strings, and deterministic canonical JSON;
- a minimal DaVinci Resolve-compatible OTIO JSON adapter for the documented cut-only subset;
- native Git objects for complete `timeline.json` snapshots, commits, refs, branches, tags,
  merge-base discovery, and two-parent merge commits;
- distinct HEAD, semantic INDEX, and WORKING snapshots;
- semantic diff, atomic hunk staging, stale-hunk protection, commands, history, checkout
  dirty guards, compare, conservative three-way merge, conflict resolution, and OTIO export;
- an Electron/React UI over a narrow typed IPC contract;
- deterministic fixtures plus unit, property, Git integration, and workflow tests.

V1 explicitly excludes media copying/CAS, proxy generation, FFmpeg rendering, Fastify,
SQLite job queues, hosted auth/collaboration, companion scripts, Premiere/FCP/AAF/EDL
adapters, and arbitrary effects. Those are V2 unless the authoritative plan changes.

## Core invariants

- Git stores full canonical timeline snapshots and ancestry. Git must never text-merge
  `timeline.json`; semantic diff, staging, and merge are TypeScript application behavior.
- Footage never enters Git. Canonical snapshots contain stable external media identities and
  metadata, never machine-local absolute paths.
- All Git subprocesses use `spawn` with argument arrays and `shell: false`. Validate ref names.
- Repository mutations are serialized per project. Move branch refs last with
  `git update-ref <ref> <new> <expected-old>` compare-and-swap semantics.
- Commits contain the complete validated INDEX snapshot and only staged semantic edits.
- A stale hunk/index/head/ref cannot overwrite newer state.
- Checkout cannot discard staged or working changes without an explicit discard choice.
- Three-way merge is deterministic and conservative: independent fields combine; same-field,
  delete-vs-modify, incompatible order, or invalid combined results become explicit conflicts.
- A conflicted or invalid merge cannot complete. Abort leaves the target ref unchanged.
- OTIO export starts from a validated immutable commit ID, not a moving branch name.
- Application state writes use temp-file-plus-rename atomic replacement.

## Application layout

Keep V1 code inside `snipsnap/src/` with these boundaries:

- `domain/`: schemas, frame math, canonical serialization, fixture builders.
- `diff/`: pure semantic diff and hunk application.
- `merge/`: pure conservative three-way merge and conflict resolution helpers.
- `commands/`: typed edit commands and validated reducer.
- `adapters/otio/`: minimal pure OTIO import/export and unsupported-content reports.
- `git/`: native Git process wrapper and object/ref/index primitives.
- `application/`: project workspace orchestration, persistence, and use cases.
- `ipc/`: shared serializable contracts and channel names.
- `main.ts`: Electron composition root and IPC registration only.
- `preload.ts`: narrow `contextBridge` implementation only.
- `renderer/`: React/Zustand UI; no Node imports.

Pure modules must not import Electron or Node filesystem/process APIs. The Git and application
services may use Node APIs but must not import renderer code.

## Development environment

- Use the project-pinned Node version in `snipsnap/.mise.toml` (Node 22.22.0). Electron Forge
  7 packaging is known to exit early under Node 26.
- Run project commands from `snipsnap/`, normally through `mise exec -- npm ...`.
- Keep TypeScript strict. Validate data at every IO boundary with Zod.
- Never commit `node_modules/`, `out/`, `.vite/`, runtime repositories, or user media.

## Verification requirements

Before claiming a change is complete, run the checks relevant to it. The full V1 gate is:

```bash
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm test
mise exec -- npm run test:integration
mise exec -- npm run build
mise exec -- npm run package
```

Tests must use temporary generated Git repositories and checked-in synthetic OTIO fixtures.
Do not depend on network access, a user's Git configuration, DaVinci Resolve, or real footage.
Verify real commit parents/refs/index contents with Git commands rather than mocking Git.

## Commit discipline

Commit frequently at coherent, tested boundaries. Do not leave a large multi-layer change as
one commit. Before each commit, inspect `git diff`, stage only files belonging to that slice,
and run the narrowest meaningful test. Never sweep unrelated user changes into a commit.

Use Conventional Commits:

```text
<type>(optional-scope): imperative summary
```

Allowed common types are `feat`, `fix`, `test`, `refactor`, `docs`, `build`, `ci`, and `chore`.
Examples:

- `feat(domain): add canonical timeline schema`
- `feat(git): commit semantic index snapshots`
- `test(merge): cover delete versus modify conflicts`
- `fix(ipc): reject stale workspace versions`

Each commit should build on its parent, avoid generated artifacts, and include tests with the
behavior whenever practical. Do not rewrite or squash the user's history unless explicitly
requested. Do not bypass hooks or use destructive Git commands.

## Definition of done

A UI that only resembles the workflow is not V1. Completion requires the documented offline
loop to operate on real data and real Git objects:

```text
import -> edit/diff -> stage -> commit -> branch -> compare -> merge/resolve -> OTIO export
```

The automated suite must prove deterministic serialization and OTIO round trips, HEAD/INDEX/
WORKING separation, selective staging, dirty checkout protection, independent and conflicting
merges, two-parent commits, stale-ref rejection, restart persistence, and no footage in Git.
