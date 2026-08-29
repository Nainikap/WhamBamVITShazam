"""Find DaVinci Resolve's scripting module and connect to the application.

Every SnipSnap script needs the same three things, and getting any of them
wrong looks like a missing module rather than a missing Resolve:

* the module lives inside the Resolve install, not on the usual import path;
* the module loads fusionscript from a path that does not match every install,
  so it has to be told where the library actually is;
* a script Resolve runs itself is already holding the application, and builds
  that refuse outside connections offer no other way in.
"""

from __future__ import annotations

import os
import sys
from typing import Any

DEFAULT_LIBRARY_CANDIDATES = [
    "/Applications/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
    "C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll",
    "/opt/resolve/libs/Fusion/fusionscript.so",
]

DEFAULT_API_CANDIDATES = [
    "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
    "/Applications/DaVinci Resolve.app/Contents/Resources/Developer/Scripting",
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Resources/Developer/Scripting",
    os.path.expanduser(
        "~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
    ),
    "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting",
    "/opt/resolve/Developer/Scripting",
]


class InjectedApplication:
    """Wraps an application object Resolve handed to a script it launched."""

    def __init__(self, application: Any) -> None:
        self._application = application

    def scriptapp(self, name: str) -> Any:
        return self._application if name == "Resolve" else None


def _point_at_fusionscript() -> None:
    configured = os.environ.get("RESOLVE_SCRIPT_LIB")
    if configured:
        return
    for candidate in DEFAULT_LIBRARY_CANDIDATES:
        if os.path.exists(candidate):
            os.environ["RESOLVE_SCRIPT_LIB"] = candidate
            return


def searched_paths() -> list[str]:
    configured = os.environ.get("RESOLVE_SCRIPT_API")
    return [configured] if configured else DEFAULT_API_CANDIDATES


def load_resolve_module(injected: Any = None) -> Any:
    """Return an object exposing ``scriptapp``. Raises ImportError if there is none."""
    if injected is not None:
        return InjectedApplication(injected)

    configured_api = os.environ.get("RESOLVE_SCRIPT_API")
    if not configured_api:
        # Resolve provides these to scripts it runs itself, including on builds
        # that refuse outside connections. An explicit API path is an override,
        # so do not silently connect through an unrelated ambient installation.
        for name in ("bmd", "fusionscript"):
            try:
                return __import__(name)
            except ImportError:
                continue

    _point_at_fusionscript()
    if not configured_api:
        try:
            import DaVinciResolveScript as resolve_script  # type: ignore[import-not-found]

            return resolve_script
        except ImportError:
            pass

    for base in searched_paths():
        modules = os.path.join(base, "Modules")
        if not os.path.isdir(modules):
            continue
        if modules not in sys.path:
            sys.path.insert(0, modules)
        try:
            import DaVinciResolveScript as resolve_script  # type: ignore[import-not-found]

            return resolve_script
        except ImportError:
            continue

    raise ImportError(
        "Could not find Resolve's scripting module. Looked in:\n  "
        + "\n  ".join(searched_paths())
        + "\nSet RESOLVE_SCRIPT_API to the Developer/Scripting folder inside your "
        "Resolve install, or run this from Resolve's Workspace > Scripts menu."
    )


def connect(injected: Any = None) -> Any:
    """Return the Resolve application, or None when it is not answering."""
    try:
        module = load_resolve_module(injected)
    except ImportError:
        return None
    try:
        return module.scriptapp("Resolve")
    except Exception:
        return None
