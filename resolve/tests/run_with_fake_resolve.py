"""Run SnipSnapSync against a stand-in for Resolve.

Resolve itself cannot run in a test, but the files the script writes are a
contract with the SnipSnap app. This exercises that contract for real: the
script's own export and manifest code runs, only the application object is
replaced.

    python3 run_with_fake_resolve.py <output-dir> <otio-fixture> [--all]
"""

from __future__ import annotations

import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import SnipSnapSync  # noqa: E402


class FakeTimeline:
    def __init__(self, name: str, fixture: str) -> None:
        self.name = name
        self.fixture = fixture

    def GetName(self) -> str:
        return self.name

    def GetStartFrame(self) -> int:
        return 0

    def GetEndFrame(self) -> int:
        return 600

    def Export(self, path: str, export_type: str, *rest) -> bool:
        assert export_type == "EXPORT_OTIO", f"unexpected export type {export_type}"
        shutil.copyfile(self.fixture, path)
        return True


class FakeProject:
    def __init__(self, name: str, timelines: list[FakeTimeline]) -> None:
        self.name = name
        self.timelines = timelines

    def GetName(self) -> str:
        return self.name

    def GetTimelineCount(self) -> int:
        return len(self.timelines)

    def GetTimelineByIndex(self, index: int) -> FakeTimeline:
        return self.timelines[index - 1]

    def GetCurrentTimeline(self) -> FakeTimeline:
        return self.timelines[-1]

    def GetSetting(self, key: str):
        return {
            "timelineFrameRate": "24.0",
            "timelineResolutionWidth": "1920",
            "timelineResolutionHeight": "1080",
        }.get(key)


class FakeManager:
    def __init__(self, projects: list[FakeProject]) -> None:
        self.projects = projects
        self.current = projects[0]

    def GetCurrentProject(self) -> FakeProject:
        return self.current

    def GetProjectListInCurrentFolder(self) -> list[str]:
        return [project.name for project in self.projects]

    def GetProjectAttributesInCurrentFolder(self) -> dict:
        return {project.name: {"lastModifiedDate": "2026-08-29 10:00:00"} for project in self.projects}

    def LoadProject(self, name: str):
        for project in self.projects:
            if project.name == name:
                self.current = project
                return project
        return None

    def ExportProject(self, name: str, file_path: str, with_stills: bool = True) -> bool:
        assert with_stills is False, "stills and LUTs should be left out of the export"
        with open(file_path, "wb") as handle:
            handle.write(f"fake DaVinci Resolve archive for {name}".encode("utf-8"))
        return True


class FakeResolve:
    EXPORT_OTIO = "EXPORT_OTIO"

    def __init__(self, manager: FakeManager) -> None:
        self.manager = manager

    def GetProjectManager(self) -> FakeManager:
        return self.manager

    def GetVersionString(self) -> str:
        return "19.1.0 (fake)"


def main() -> int:
    output, fixture = sys.argv[1], sys.argv[2]
    every = "--all" in sys.argv[3:]
    manager = FakeManager([
        FakeProject("Launch Promo", [
            FakeTimeline("Launch Promo v1", fixture),
            FakeTimeline("Launch Promo v2", fixture),
        ]),
        FakeProject("Second Project", [FakeTimeline("Second Cut", fixture)]),
    ])
    SnipSnapSync.connect = lambda: FakeResolve(manager)
    return SnipSnapSync.run_once(output, every)


if __name__ == "__main__":
    sys.exit(main())
