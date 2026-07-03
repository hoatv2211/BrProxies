from __future__ import annotations

import os
import shutil
from pathlib import Path


ANDROID_TOOL_RELATIVE_PATHS = {
    "adb": [Path("platform-tools") / "adb.exe", Path("platform-tools") / "adb"],
    "emulator": [Path("emulator") / "emulator.exe", Path("emulator") / "emulator"],
    "avdmanager": [Path("cmdline-tools") / "latest" / "bin" / "avdmanager.bat", Path("cmdline-tools") / "latest" / "bin" / "avdmanager"],
    "sdkmanager": [Path("cmdline-tools") / "latest" / "bin" / "sdkmanager.bat", Path("cmdline-tools") / "latest" / "bin" / "sdkmanager"],
    "scrcpy": [Path("scrcpy.exe"), Path("scrcpy")],
}


def android_sdk_roots() -> list[Path]:
    roots: list[Path] = []
    for env_name in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        value = os.getenv(env_name)
        if value:
            roots.append(Path(value))
    local_app_data = os.getenv("LOCALAPPDATA")
    if local_app_data:
        roots.append(Path(local_app_data) / "Android" / "Sdk")
    home = Path.home()
    roots.extend([home / "AppData" / "Local" / "Android" / "Sdk", home / "Android" / "Sdk"])
    seen: set[str] = set()
    unique: list[Path] = []
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            unique.append(root)
    return unique


def find_android_tool(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for root in android_sdk_roots():
        for rel in ANDROID_TOOL_RELATIVE_PATHS.get(name, [Path(name)]):
            path = root / rel
            if path.exists():
                return str(path)
    return None
