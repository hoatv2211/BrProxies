from __future__ import annotations

import shutil
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(slots=True)
class HostCheck:
    name: str
    ok: bool
    detail: str


def validate_host() -> dict[str, object]:
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
    return {"ok": all(item.ok for item in required), "checks": [asdict(item) for item in checks]}
