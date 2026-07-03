from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

from android_manager.tool_locator import find_android_tool


@dataclass(slots=True)
class HostCheck:
    name: str
    ok: bool
    detail: str


def validate_host(runtime: str = "redroid") -> dict[str, object]:
    if runtime == "fake":
        checks = [HostCheck("fake", True, "debug runtime; no real Android window opens")]
        return {"ok": True, "runtime": runtime, "checks": [asdict(item) for item in checks]}

    if runtime == "windows_avd":
        checks = [
            HostCheck("adb", find_android_tool("adb") is not None, "adb CLI in PATH or Android SDK"),
            HostCheck("emulator", find_android_tool("emulator") is not None, "Android emulator CLI in PATH or Android SDK"),
            HostCheck("avdmanager", find_android_tool("avdmanager") is not None, "Android avdmanager CLI in PATH or Android SDK cmdline-tools"),
            HostCheck("sdkmanager", find_android_tool("sdkmanager") is not None, "Android sdkmanager CLI in PATH or Android SDK cmdline-tools"),
            HostCheck("scrcpy", find_android_tool("scrcpy") is not None, "scrcpy CLI on PATH"),
        ]
        required = [item for item in checks if item.name in {"adb", "emulator", "avdmanager"}]
        return {"ok": all(item.ok for item in required), "runtime": runtime, "checks": [asdict(item) for item in checks]}

    checks = [
        HostCheck("docker", find_android_tool("docker") is not None, "docker CLI on PATH"),
        HostCheck("adb", find_android_tool("adb") is not None, "adb CLI in PATH or Android SDK"),
        HostCheck("scrcpy", find_android_tool("scrcpy") is not None, "scrcpy CLI on PATH"),
        HostCheck(
            "binder",
            Path("/dev/binder").exists() and Path("/dev/hwbinder").exists() and Path("/dev/vndbinder").exists(),
            "requires /dev/binder, /dev/hwbinder, /dev/vndbinder on Linux host",
        ),
    ]
    required = [item for item in checks if item.name in {"docker", "adb", "binder"}]
    return {"ok": all(item.ok for item in required), "runtime": runtime, "checks": [asdict(item) for item in checks]}
