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
    if name == "scrcpy":
        home = Path.home()
        winget_root = home / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
        if winget_root.exists():
            matches = sorted(winget_root.glob("Genymobile.scrcpy_*/*/scrcpy.exe"))
            matches.extend(sorted(winget_root.glob("Genymobile.scrcpy_*/*/scrcpy")))
            matches.extend(sorted(winget_root.glob("Genymobile.scrcpy_*/scrcpy.exe")))
            matches.extend(sorted(winget_root.glob("Genymobile.scrcpy_*/scrcpy")))
            for path in matches:
                if path.exists():
                    return str(path)
    return None


def find_java_home() -> str | None:
    value = os.getenv("JAVA_HOME")
    if value and (Path(value) / "bin" / "java.exe").exists():
        return value
    roots: list[Path] = []
    program_files = os.getenv("ProgramFiles")
    if program_files:
        roots.append(Path(program_files) / "Android" / "Android Studio" / "jbr")
    program_files_x86 = os.getenv("ProgramFiles(x86)")
    if program_files_x86:
        roots.append(Path(program_files_x86) / "Android" / "Android Studio" / "jbr")
    for root in roots:
        if (root / "bin" / "java.exe").exists() or (root / "bin" / "java").exists():
            return str(root)
    return None
