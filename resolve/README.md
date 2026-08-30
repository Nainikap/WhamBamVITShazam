# SnipSnap sync for DaVinci Resolve

`SnipSnapSync.py` exports what SnipSnap needs to version your edit:

```text
macOS:   ~/Library/Application Support/SnipSnap/resolve/
Windows: %APPDATA%\SnipSnap\resolve\

  manifest.json
  <project>/<project>.drp        the Resolve project file
  <project>/<timeline>.otio      one export per timeline
```

SnipSnap lists a project only when both files are present, and opening a project
in SnipSnap reads them straight from that folder.

## Install

Copy the script into Resolve's script menu:

```bash
mkdir -p ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility
cp resolve/SnipSnapSync.py resolve/resolve_connection.py ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility/
```

It then appears under **Workspace › Scripts › SnipSnapSync**.

## Run

From Resolve's script menu, or from a terminal while Resolve is open:

```bash
python3 resolve/SnipSnapSync.py             # the project that is open right now
python3 resolve/SnipSnapSync.py --all       # every project in the current database
python3 resolve/SnipSnapSync.py --watch 15  # keep exporting every 15 seconds
```

`--all` loads each project in turn and restores the one you started on, so run it
between edits rather than during one.

## Live save sync

Open a versioned project in SnipSnap and press **Start save sync**. SnipSnap launches
`SnipSnapSaveBridge.py`, which observes only Resolve's persisted `lastModifiedDate`.
It does not debounce individual edits and it does not export on a timer. Each distinct
project save causes one atomic OTIO handoff; the newest saved timeline replaces SnipSnap
WORKING, while HEAD and the staging index remain unchanged.

External scripting must be enabled for this mode. In Resolve choose **Preferences ›
System › General › External scripting using: Local**. Manual OTIO file connection remains
available in the editor if the installed Resolve edition blocks external scripting.

Scripting must be enabled in Resolve: **Preferences › System › General › External
scripting using** set to `Local`.

## Already have exports elsewhere?

If you keep `.drp` files beside their `.otio` exports in another folder, use
**Add folder** on the SnipSnap dashboard and point it there. SnipSnap scans up to
four levels deep and pairs each `.drp` with an `.otio` in the same directory.
