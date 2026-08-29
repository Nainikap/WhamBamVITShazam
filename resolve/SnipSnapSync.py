#!/usr/bin/env python3
"""Export DaVinci Resolve projects so SnipSnap can version them.

For every project this script touches it writes two files into one folder:

    <output>/<project-slug>/<project-slug>.drp        the Resolve project
    <output>/<project-slug>/<timeline-slug>.otio      one per timeline

and records them in <output>/manifest.json, which SnipSnap reads to list
projects. A project with no .drp or no .otio is left out of the manifest,
because SnipSnap will not show a project it cannot open.

Run it from Resolve's Workspace > Scripts menu, or from a shell while
Resolve is running:

    python3 SnipSnapSync.py                 # the project that is open now
    python3 SnipSnapSync.py --all           # every project in the database
    python3 SnipSnapSync.py --watch 15      # re-export every 15 seconds

--all loads each project in turn and restores the original afterwards, so
only use it when nobody is mid-edit.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

DEFAULT_OUTPUT = os.path.expanduser("~/Library/Application Support/SnipSnap/resolve")
LIBRARY_CANDIDATES = [
    os.environ.get("RESOLVE_SCRIPT_LIB"),
    "/Applications/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
    "C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll",
    "/opt/resolve/libs/Fusion/fusionscript.so",
]
MODULE_CANDIDATES = [
    os.environ.get("RESOLVE_SCRIPT_API"),
    "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
    "/Applications/DaVinci Resolve.app/Contents/Resources/Developer/Scripting",
    os.path.expanduser(
        "~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
    ),
    "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting",
    "/opt/resolve/Developer/Scripting",
]


def connect():
    """Return the Resolve application object, or None when it is not running.

    Run from Resolve's own Scripts menu the application is already in scope,
    which is the only way in on builds that block external scripting.
    """
    injected = globals().get("resolve")
    if injected is not None:
        return injected
    try:
        import bmd  # type: ignore  # Provided by Resolve to scripts it runs itself.

        application = bmd.scriptapp("Resolve")
        if application is not None:
            return application
    except Exception:
        pass
    try:
        import fusionscript as script_module  # type: ignore  # In-process on some builds.

        application = script_module.scriptapp("Resolve")
        if application is not None:
            return application
    except Exception:
        pass
    # The bundled module looks for fusionscript.so under a path that does not
    # match every install, so point it at the copy that is actually here.
    if not os.environ.get("RESOLVE_SCRIPT_LIB"):
        for candidate in LIBRARY_CANDIDATES:
            if candidate and os.path.exists(candidate):
                os.environ["RESOLVE_SCRIPT_LIB"] = candidate
                break
    try:
        import DaVinciResolveScript as script_module  # type: ignore
    except ImportError:
        script_module = None
        for base in MODULE_CANDIDATES:
            if not base:
                continue
            modules = os.path.join(base, "Modules")
            if os.path.isdir(modules):
                sys.path.append(modules)
                try:
                    import DaVinciResolveScript as script_module  # type: ignore
                    break
                except ImportError:
                    script_module = None
        if script_module is None:
            return None
    try:
        return script_module.scriptapp("Resolve")
    except Exception:
        return None


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", (value or "untitled").strip())
    return re.sub(r"-{2,}", "-", cleaned).strip("-.") or "untitled"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def file_record(path: str) -> dict | None:
    """Describe a file that must exist before SnipSnap will trust it."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    if info.st_size <= 0:
        return None
    return {
        "path": path,
        "bytes": info.st_size,
        "modifiedAt": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(timespec="seconds"),
    }


def export_timelines(project, folder: str) -> tuple[list[dict], str | None]:
    """Write one OTIO per timeline and report which timeline is open."""
    from_resolve = connect()
    export_otio = getattr(from_resolve, "EXPORT_OTIO", "EXPORT_OTIO")
    current = project.GetCurrentTimeline()
    current_name = current.GetName() if current else None
    timelines = []

    for index in range(1, int(project.GetTimelineCount() or 0) + 1):
        timeline = project.GetTimelineByIndex(index)
        if not timeline:
            continue
        name = timeline.GetName()
        target = os.path.join(folder, f"{slugify(name)}.otio")
        try:
            exported = timeline.Export(target, export_otio)
        except Exception as error:  # A single bad timeline must not stop the rest.
            print(f"  ! timeline {name!r} could not be exported: {error}")
            continue
        if not exported:
            print(f"  ! timeline {name!r} could not be exported")
            continue
        record = file_record(target)
        if not record:
            continue
        timelines.append({
            "name": name,
            "otio": record["path"],
            "bytes": record["bytes"],
            "modifiedAt": record["modifiedAt"],
            "startFrame": timeline.GetStartFrame(),
            "endFrame": timeline.GetEndFrame(),
            "isCurrent": name == current_name,
        })
        print(f"  · timeline {name!r} -> {target}")

    return timelines, current_name


def project_settings(project) -> dict:
    keys = {
        "fps": "timelineFrameRate",
        "width": "timelineResolutionWidth",
        "height": "timelineResolutionHeight",
    }
    settings = {}
    for label, key in keys.items():
        try:
            value = project.GetSetting(key)
        except Exception:
            value = None
        if value in (None, ""):
            continue
        try:
            settings[label] = float(value) if label == "fps" else int(value)
        except (TypeError, ValueError):
            settings[label] = value
    return settings


def export_project(manager, project, output: str, attributes: dict) -> dict | None:
    name = project.GetName()
    folder = os.path.join(output, slugify(name))
    os.makedirs(folder, exist_ok=True)
    drp_path = os.path.join(folder, f"{slugify(name)}.drp")

    print(f"- {name}")
    try:
        # Stills and LUTs make the archive far larger; the timeline is what we version.
        exported = manager.ExportProject(name, drp_path, False)
    except Exception as error:
        print(f"  ! project file could not be written: {error}")
        return None
    drp = file_record(drp_path) if exported else None
    if not drp:
        print("  ! project file could not be written")
        return None
    print(f"  · project -> {drp_path}")

    timelines, current = export_timelines(project, folder)
    if not timelines:
        print("  ! no timeline exported, so SnipSnap will skip this project")
        return None

    return {
        "name": name,
        "slug": slugify(name),
        "folder": folder,
        "drp": drp["path"],
        "drpBytes": drp["bytes"],
        "drpModifiedAt": drp["modifiedAt"],
        "currentTimeline": current,
        "timelines": timelines,
        "settings": project_settings(project),
        "lastModifiedDate": attributes.get("lastModifiedDate"),
        "exportedAt": now(),
    }


def walk_projects(manager, resolve, output: str, every: bool) -> list[dict]:
    current = manager.GetCurrentProject()
    if current is None:
        print("No project is open in Resolve.")
        return []

    try:
        attributes = manager.GetProjectAttributesInCurrentFolder() or {}
    except Exception:
        attributes = {}

    if not every:
        record = export_project(manager, current, output, attributes.get(current.GetName(), {}))
        return [record] if record else []

    original = current.GetName()
    records = []
    for name in manager.GetProjectListInCurrentFolder() or []:
        project = current if name == original else manager.LoadProject(name)
        if project is None:
            print(f"- {name}\n  ! could not be opened")
            continue
        record = export_project(manager, project, output, attributes.get(name, {}))
        if record:
            records.append(record)
    if manager.GetCurrentProject() and manager.GetCurrentProject().GetName() != original:
        manager.LoadProject(original)
    return records


def write_manifest(output: str, projects: list[dict], resolve) -> str:
    os.makedirs(output, exist_ok=True)
    manifest_path = os.path.join(output, "manifest.json")
    payload = {
        "version": 1,
        "generatedAt": now(),
        "resolveVersion": getattr(resolve, "GetVersionString", lambda: "unknown")(),
        "projects": sorted(projects, key=lambda item: item["exportedAt"], reverse=True),
    }
    temporary = f"{manifest_path}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(temporary, manifest_path)
    return manifest_path


def run_once(output: str, every: bool) -> int:
    resolve = connect()
    if resolve is None:
        print(
            "Could not reach DaVinci Resolve. Start Resolve, and make sure external "
            "scripting is set to Local in Preferences > System > General."
        )
        return 1
    manager = resolve.GetProjectManager()
    if manager is None:
        print("Resolve did not return a project manager.")
        return 1

    projects = walk_projects(manager, resolve, output, every)
    manifest = write_manifest(output, projects, resolve)
    print(f"\n{len(projects)} project(s) ready for SnipSnap")
    print(f"Manifest: {manifest}")
    return 0 if projects else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Export Resolve projects for SnipSnap.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Folder SnipSnap reads from.")
    parser.add_argument("--all", action="store_true", help="Export every project, not only the open one.")
    parser.add_argument("--watch", type=int, metavar="SECONDS", help="Keep exporting on an interval.")
    arguments = parser.parse_args()

    output = os.path.abspath(os.path.expanduser(arguments.output))
    if not arguments.watch:
        return run_once(output, arguments.all)

    interval = max(5, arguments.watch)
    print(f"Watching Resolve every {interval}s. Press Ctrl+C to stop.")
    while True:
        try:
            run_once(output, arguments.all)
        except KeyboardInterrupt:
            return 0
        except Exception as error:
            print(f"Export failed: {error}")
        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            return 0


if __name__ == "__main__":
    sys.exit(main())
