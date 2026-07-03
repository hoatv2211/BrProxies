from __future__ import annotations

import subprocess


class ScrcpyService:
    def __init__(self, fake: bool = False) -> None:
        self.fake = fake

    def open_screen(self, adb_host: str, adb_port: int) -> None:
        if not self.fake:
            subprocess.Popen(["scrcpy", "-s", f"{adb_host}:{adb_port}", "--no-audio"])
