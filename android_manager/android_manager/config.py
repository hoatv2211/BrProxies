from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class AndroidManagerConfig:
    host: str = "127.0.0.1"
    port: int = 40327
    redroid_image: str = "redroid/redroid:12.0.0-latest"
    adb_port_start: int = 5555
    adb_port_end: int = 5999
    container_prefix: str = "brproxies-android-"
    volume_prefix: str = "brproxies_android_"
    data_dir: str = "./data"
    fake_runtime: bool = False

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> "AndroidManagerConfig":
        defaults = cls()
        return cls(
            host=str(data.get("host", defaults.host)),
            port=int(data.get("port", defaults.port)),
            redroid_image=str(data.get("redroid_image", defaults.redroid_image)),
            adb_port_start=int(data.get("adb_port_start", defaults.adb_port_start)),
            adb_port_end=int(data.get("adb_port_end", defaults.adb_port_end)),
            container_prefix=str(data.get("container_prefix", defaults.container_prefix)),
            volume_prefix=str(data.get("volume_prefix", defaults.volume_prefix)),
            data_dir=str(data.get("data_dir", defaults.data_dir)),
            fake_runtime=bool(data.get("fake_runtime", defaults.fake_runtime)),
        )


def load_config(path: str | None = None) -> AndroidManagerConfig:
    data: dict[str, Any] = {}
    if path:
        cfg_path = Path(path)
        if cfg_path.exists():
            data.update(json.loads(cfg_path.read_text(encoding="utf-8")))

    env_map = {
        "ANDROID_MANAGER_HOST": "host",
        "ANDROID_MANAGER_PORT": "port",
        "ANDROID_MANAGER_REDROID_IMAGE": "redroid_image",
        "ANDROID_MANAGER_ADB_PORT_START": "adb_port_start",
        "ANDROID_MANAGER_ADB_PORT_END": "adb_port_end",
        "ANDROID_MANAGER_DATA_DIR": "data_dir",
        "ANDROID_MANAGER_FAKE_RUNTIME": "fake_runtime",
    }
    for env_name, field_name in env_map.items():
        value = os.getenv(env_name)
        if value is None:
            continue
        data[field_name] = value.lower() in {"1", "true", "yes", "on"} if field_name == "fake_runtime" else value
    return AndroidManagerConfig.from_mapping(data)
