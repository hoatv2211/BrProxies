from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class AndroidManagerConfig:
    runtime: str = "redroid"
    host: str = "127.0.0.1"
    port: int = 40327
    redroid_image: str = "redroid/redroid:12.0.0-latest"
    avd_system_image: str = "system-images;android-35;google_apis;x86_64"
    avd_device: str = "pixel_2"
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
            runtime=str(data.get("runtime", defaults.runtime)),
            host=str(data.get("host", defaults.host)),
            port=int(data.get("port", defaults.port)),
            redroid_image=str(data.get("redroid_image", defaults.redroid_image)),
            avd_system_image=str(data.get("avd_system_image", defaults.avd_system_image)),
            avd_device=str(data.get("avd_device", defaults.avd_device)),
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
        "ANDROID_MANAGER_RUNTIME": "runtime",
        "ANDROID_MANAGER_PORT": "port",
        "ANDROID_MANAGER_REDROID_IMAGE": "redroid_image",
        "ANDROID_MANAGER_AVD_SYSTEM_IMAGE": "avd_system_image",
        "ANDROID_MANAGER_AVD_DEVICE": "avd_device",
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
