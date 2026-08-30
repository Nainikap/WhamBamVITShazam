# SnipSnap desktop application

This directory contains the Electron application for SnipSnap, Git-style semantic version control
for DaVinci Resolve and Kdenlive timelines. For the product overview and editor workflows, start
with the [repository README](../README.md).

## Set up the development environment

Git, npm, and Node.js 22.22.0 are required. The local `.mise.toml` pins the correct Node release.

Linux, macOS, and Windows PowerShell use the same project commands:

```bash
mise install
mise exec -- npm ci
mise exec -- npm start
```

Run them from this directory. On Windows, the commands can be entered directly in PowerShell. If
Node 22.22.0 is already active through another version manager, use `npm ci` and `npm start` without
the `mise exec --` prefix.

`npm start` launches the Vite development server and Electron window. Keep the terminal open while
the app is running; press **Ctrl+C** to stop it.

## Build and package

```bash
mise exec -- npm run build    # unpacked application under out/
mise exec -- npm run package  # same packaging gate used by the project
mise exec -- npm run make     # distributable for the current operating system
```

Create Windows, macOS, and Linux distributables on their respective operating systems. Electron
Forge is configured for Windows Squirrel, macOS ZIP, Debian, and RPM outputs.

## Test

```bash
mise exec -- npm run typecheck
mise exec -- npm run lint
mise exec -- npm test
mise exec -- npm run test:integration
mise exec -- npm run build
mise exec -- npm run package
```

Changes to the UI, IPC boundary, preview, editor integration, or collaboration should also run the
packaged Electron journeys:

```bash
mise exec -- npm run test:e2e
```

Tests create temporary Git repositories and data roots. They do not need Resolve, Kdenlive, real
footage, or a configured global Git identity.

## Code boundaries

```text
src/domain/              timeline schema, validation, frame math, canonical JSON
src/adapters/            OTIO and native Kdenlive readers/writers
src/diff/                semantic differences and atomic staging
src/merge/               conservative three-way merge
src/git/                 native Git objects, refs, and repository operations
src/application/         project workflows and editor/collaboration services
src/ipc/                 typed serializable IPC contract
src/renderer/            sandboxed React and Zustand interface
```

The renderer must not import Node, Electron, filesystem, process, or child-process APIs. Those stay
behind the typed preload and main-process IPC boundary. Footage and machine-local paths must never
enter committed `timeline.json` snapshots.
