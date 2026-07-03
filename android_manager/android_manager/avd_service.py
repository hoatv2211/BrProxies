from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Callable, Protocol

from android_manager.tool_locator import android_sdk_roots, find_android_tool


class RunFn(Protocol):
    def __call__(self, args: list[str], **kwargs: object) -> object: ...


class PopenFn(Protocol):
    def __call__(self, args: list[str], **kwargs: object) -> object: ...


class AvdService:
    def __init__(
        self,
        data_dir: str,
        system_image: str = "system-images;android-35;google_apis;x86_64",
        device: str = "pixel_6",
        sdk_root: str | None = None,
        runner: RunFn | None = None,
        popen: PopenFn | None = None,
        which: Callable[[str], str | None] | None = None,
    ) -> None:
        self.data_dir = data_dir
        self.system_image = system_image
        self.device = device
        self.sdk_root = Path(sdk_root) if sdk_root else None
        self.runner = runner or subprocess.run
        self.popen = popen or subprocess.Popen
        self.which = which or find_android_tool

    def serial(self, console_port: int) -> str:
        return f"emulator-{console_port}"

    def _tool(self, name: str) -> str:
        path = self.which(name)
        if not path:
            raise RuntimeError(f"{name} CLI not found on PATH")
        return path

    def create(self, avd_name: str) -> None:
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        self.runner(
            [
                self._tool("avdmanager"),
                "create",
                "avd",
                "--force",
                "--name",
                avd_name,
                "--package",
                self.resolve_system_image(),
                "--device",
                self.device,
            ],
            input="no\n",
            text=True,
            check=True,
        )

    def resolve_system_image(self) -> str:
        configured = self.system_image
        parts = configured.split(";")
        if len(parts) == 4 and self._system_image_exists(parts[1], parts[2], parts[3]):
            return configured
        for api in ("android-35", "android-36"):
            for flavor in ("google_apis_playstore", "google_apis", "default"):
                if self._system_image_exists(api, flavor, "x86_64"):
                    return f"system-images;{api};{flavor};x86_64"
        return configured

    def _system_image_exists(self, api: str, flavor: str, abi: str) -> bool:
        roots = [self.sdk_root] if self.sdk_root else android_sdk_roots()
        return any(root and (root / "system-images" / api / flavor / abi).exists() for root in roots)

    def start(self, avd_name: str, console_port: int) -> None:
        self.popen([self._tool("emulator"), "-avd", avd_name, "-port", str(console_port), "-no-snapshot-save"])
        serial = self.serial(console_port)
        self.runner([self._tool("adb"), "-s", serial, "wait-for-device"], check=True)
        deadline = time.time() + 90
        while True:
            result = self.runner([self._tool("adb"), "-s", serial, "shell", "getprop", "sys.boot_completed"], check=True, capture_output=True, text=True)
            if str(getattr(result, "stdout", "")).strip() == "1":
                return
            if time.time() > deadline:
                raise TimeoutError(f"Android emulator did not boot: {serial}")
            time.sleep(1)

    def stop(self, console_port: int) -> None:
        self.runner([self._tool("adb"), "-s", self.serial(console_port), "emu", "kill"], check=False)

    def delete(self, avd_name: str) -> None:
        self.runner([self._tool("avdmanager"), "delete", "avd", "--name", avd_name], check=False)

    def install_apk(self, console_port: int, apk_path: str) -> None:
        if not Path(apk_path).exists():
            raise FileNotFoundError(apk_path)
        self.runner([self._tool("adb"), "-s", self.serial(console_port), "install", "-r", apk_path], check=True)

    def screenshot(self, console_port: int, output_path: str) -> None:
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("wb") as out:
            self.runner([self._tool("adb"), "-s", self.serial(console_port), "exec-out", "screencap", "-p"], stdout=out, check=True)

    def set_http_proxy(self, console_port: int, host: str, port: int) -> None:
        self.runner([self._tool("adb"), "-s", self.serial(console_port), "shell", "settings", "put", "global", "http_proxy", f"{host}:{port}"], check=True)

    def clear_http_proxy(self, console_port: int) -> None:
        self.runner([self._tool("adb"), "-s", self.serial(console_port), "shell", "settings", "put", "global", "http_proxy", ":0"], check=True)

    def open_screen(self, console_port: int) -> bool:
        scrcpy = self.which("scrcpy")
        if not scrcpy:
            return False
        self.popen([scrcpy, "-s", self.serial(console_port), "--no-audio"])
        return True
