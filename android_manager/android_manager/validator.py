from __future__ import annotations

import shutil
from dataclasses import asdict, dataclass
from pathlib import Path


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
            HostCheck("adb", shutil.which("adb") is not None, "adb CLI on PATH"),
            HostCheck("emulator", shutil.which("emulator") is not None, "Android emulator CLI on PATH"),
            HostCheck("avdmanager", shutil.which("avdmanager") is not None, "Android avdmanager CLI on PATH"),
            HostCheck("sdkmanager", shutil.which("sdkmanager") is not None, "Android sdkmanager CLI on PATH"),
            HostCheck("scrcpy", shutil.which("scrcpy") is not None, "scrcpy CLI on PATH"),
        ]
        required = [item for item in checks if item.name in {"adb", "emulator", "avdmanager", "scrcpy"}]
        return {"ok": all(item.ok for item in required), "runtime": runtime, "checks": [asdict(item) for item in checks]}

    checks = [
        HostCheck("docker", shutil.which("docker") is not None, "docker CLI on PATH"),
        HostCheck("adb", shutil.which("adb") is not None, "adb CLI on PATH"),
        HostCheck("scrcpy", shutil.which("scrcpy") is not None, "scrcpy CLI on PATH"),
        HostCheck(
            "binder",
            Path("/dev/binder").exists() and Path("/dev/hwbinder").exists() and Path("/dev/vndbinder").exists(),
            "requires /dev/binder, /dev/hwbinder, /dev/vndbinder on Linux host",
        ),
    ]
    required = [item for item in checks if item.name in {"docker", "adb", "binder"}]
    return {"ok": all(item.ok for item in required), "runtime": runtime, "checks": [asdict(item) for item in checks]}
