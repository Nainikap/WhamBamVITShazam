# Connect SnipSnap to DaVinci Resolve

SnipSnap versions saved Resolve timeline decisions. `SnipSnapSaveBridge.py` handles save-driven sync
for a connected project, while `SnipSnapSync.py` is the Resolve menu and command-line export
fallback. `resolve_connection.py` is the shared Resolve API loader used by both scripts.

SnipSnap never edits the Resolve project and never commits the `.drp` or footage to Git.

## Recommended: managed save sync

1. In Resolve open **Preferences > System > General**.
2. Set **External scripting using** to **Local** and restart Resolve if it requests it.
3. Open a project with a timeline and save it once.
4. Start SnipSnap, open the detected project, and choose **Start save sync**.
5. Edit in Resolve and save normally.
6. Review, stage, and commit the resulting semantic changes in SnipSnap.

The bridge observes Resolve's persisted save marker. It does not poll every edit, create commits, or
queue duplicate saves. Each new saved timeline replaces the source state SnipSnap compares while the
current commit and staging area remain under user control.

Python 3 must be available to SnipSnap for managed sync.

## Resolve menu export fallback

Choose **Export from Resolve** in SnipSnap first. If Resolve cannot accept outside scripting,
SnipSnap attempts to install `SnipSnapSync.py` and `resolve_connection.py` into an existing Resolve
Scripts location. Then choose **Workspace > Scripts > SnipSnapSync** inside Resolve and refresh the
SnipSnap dashboard.

The script exports:

```text
manifest.json
<project>/<project>.drp
<project>/<timeline>.otio
```

Default export roots are:

```text
Linux:   ~/.local/share/SnipSnap/resolve/
macOS:   ~/Library/Application Support/SnipSnap/resolve/
Windows: %APPDATA%\SnipSnap\resolve\
```

SnipSnap lists an exported Resolve project when its `.drp` and at least one timeline `.otio` are
available.

## Manual script installation

Copy both `SnipSnapSync.py` and `resolve_connection.py` into Resolve's **Utility** Scripts folder.
Create the folder if Resolve is installed but the folder does not exist.

### Linux

```bash
mkdir -p ~/.local/share/DaVinciResolve/Fusion/Scripts/Utility
cp resolve/SnipSnapSync.py resolve/resolve_connection.py \
  ~/.local/share/DaVinciResolve/Fusion/Scripts/Utility/
```

The system-wide Resolve installation may instead use
`/opt/resolve/Fusion/Scripts/Utility/`, which can require administrator permission.

### macOS

```bash
mkdir -p ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility
cp resolve/SnipSnapSync.py resolve/resolve_connection.py \
  ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility/
```

Sandboxed Resolve installations may use a Scripts directory inside their application container.
Using **Export from Resolve** in SnipSnap is the easiest way to select a detected writable location.

### Windows PowerShell

```powershell
$scripts = Join-Path $env:APPDATA 'Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility'
New-Item -ItemType Directory -Force -Path $scripts | Out-Null
Copy-Item resolve\SnipSnapSync.py, resolve\resolve_connection.py -Destination $scripts
```

After installation, restart Resolve if necessary. The exporter appears under
**Workspace > Scripts > SnipSnapSync**.

## Run the exporter from a terminal

Run these commands from the repository root while Resolve is open and external scripting is
enabled:

```bash
python3 resolve/SnipSnapSync.py             # currently open project
python3 resolve/SnipSnapSync.py --all       # every project in the current database
python3 resolve/SnipSnapSync.py --watch 15  # export every 15 seconds
```

On Windows, use `python` instead of `python3` when that is the installed command:

```powershell
python resolve\SnipSnapSync.py
```

`--all` loads projects one at a time and restores the project that was initially open. Run it
between edits, not during an active edit session. Managed save sync is preferred over `--watch`
when available because it reacts to saved state instead of a timer.

## Manual `.drp` and OTIO folder

If scripts are unavailable:

1. Export the Resolve project as `.drp`.
2. Export its timeline as `.otio` into the same folder.
3. In SnipSnap choose **Track Resolve folder** and select that folder.

SnipSnap scans up to four directories below the selected root and pairs each `.drp` with timelines
beside it. You can also connect a single OTIO source from an already imported project.

## Environment overrides

Custom and portable installations can override discovery with:

- `SNIPSNAP_RESOLVE_ROOT` for script export roots;
- `SNIPSNAP_RESOLVE_DATABASE` for Resolve project-library roots;
- `SNIPSNAP_RESOLVE_SCRIPTS` for menu-script installation folders;
- `SNIPSNAP_RESOLVE_SCAN` for folders searched for manual exports.

Use the operating system's path-list separator to provide more than one location (`:` on Linux and
macOS, `;` on Windows).
