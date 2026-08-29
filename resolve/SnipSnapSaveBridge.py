#!/usr/bin/env python3
"""Export the active Resolve timeline exactly once for each saved project state."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


POLL_SECONDS = 0.5
RECONNECT_SECONDS = 1.0


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)


def load_resolve_module() -> Any:
    try:
        import DaVinciResolveScript as resolve_script  # type: ignore[import-not-found]
        return resolve_script
    except ImportError:
        api_root = os.environ.get("RESOLVE_SCRIPT_API")
        if api_root:
            modules = str(Path(api_root) / "Modules")
            if modules not in sys.path:
                sys.path.insert(0, modules)
        import DaVinciResolveScript as resolve_script  # type: ignore[import-not-found]
        return resolve_script


def saved_marker(project_manager: Any, project: Any, timeline: Any) -> str | None:
    attributes = project_manager.GetProjectAttributesInCurrentFolder() or {}
    current = attributes.get(project.GetName()) or {}
    modified = current.get("lastModifiedDate")
    if not modified:
        return None
    return json.dumps(
        {
            "projectId": str(project.GetUniqueId()),
            "timelineId": str(timeline.GetUniqueId()),
            "lastModifiedDate": str(modified),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def export_atomic(resolve: Any, timeline: Any, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.stem}.{uuid.uuid4().hex}.otio")
    try:
        if not timeline.Export(str(temporary), resolve.EXPORT_OTIO):
            raise RuntimeError("Resolve rejected the OTIO export")
        os.replace(temporary, output_path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def run(output_path: Path) -> None:
    resolve_script = load_resolve_module()
    last_marker: str | None = None
    last_status: str | None = None
    next_connect_at = 0.0

    while True:
        monotonic_now = time.monotonic()
        if monotonic_now < next_connect_at:
            time.sleep(min(POLL_SECONDS, next_connect_at - monotonic_now))
            continue

        resolve = resolve_script.scriptapp("Resolve")
        manager = resolve.GetProjectManager() if resolve else None
        project = manager.GetCurrentProject() if manager else None
        timeline = project.GetCurrentTimeline() if project else None
        if not resolve or not manager or not project or not timeline:
            if last_status != "waiting-for-resolve":
                emit({
                    "type": "status",
                    "state": "waiting-for-resolve",
                    "message": "Open Resolve and select a timeline, then save the project.",
                })
                last_status = "waiting-for-resolve"
            next_connect_at = time.monotonic() + RECONNECT_SECONDS
            continue

        marker = saved_marker(manager, project, timeline)
        if marker is None:
            if last_status != "waiting-for-resolve":
                emit({
                    "type": "status",
                    "state": "waiting-for-resolve",
                    "message": "Save the current Resolve project once to begin synchronization.",
                })
                last_status = "waiting-for-resolve"
            time.sleep(POLL_SECONDS)
            continue

        if marker != last_marker:
            export_atomic(resolve, timeline, output_path)
            emit({
                "type": "snapshot",
                "path": str(output_path.resolve()),
                "marker": marker,
                "savedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "projectName": str(project.GetName()),
                "timelineName": str(timeline.GetName()),
            })
            last_marker = marker

        if last_status != "watching":
            emit({"type": "status", "state": "watching"})
            last_status = "watching"
        time.sleep(POLL_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    run(arguments.output)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        raise
