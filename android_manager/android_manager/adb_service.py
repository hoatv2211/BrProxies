from __future__ import annotations

import base64
import subprocess
from pathlib import Path

EMPTY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class AdbService:
    def __init__(self, fake: bool = False) -> None:
        self.fake = fake

    def serial(self, adb_host: str, adb_port: int) -> str:
        return f"{adb_host}:{adb_port}"

    def connect(self, adb_host: str, adb_port: int) -> None:
        if not self.fake:
            subprocess.run(["adb", "connect", self.serial(adb_host, adb_port)], check=False)

    def install_apk(self, adb_host: str, adb_port: int, apk_path: str) -> None:
        if not Path(apk_path).exists():
            raise FileNotFoundError(apk_path)
        if not self.fake:
            subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "install", "-r", apk_path], check=True)

    def screenshot(self, adb_host: str, adb_port: int, output_path: str) -> None:
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if self.fake:
            out_path.write_bytes(EMPTY_PNG)
            return
        with out_path.open("wb") as out:
            subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "exec-out", "screencap", "-p"], stdout=out, check=True)

    def set_http_proxy(self, adb_host: str, adb_port: int, host: str, port: int) -> None:
        if not self.fake:
            subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "shell", "settings", "put", "global", "http_proxy", f"{host}:{port}"], check=True)

    def clear_http_proxy(self, adb_host: str, adb_port: int) -> None:
        if not self.fake:
            subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "shell", "settings", "put", "global", "http_proxy", ":0"], check=True)
