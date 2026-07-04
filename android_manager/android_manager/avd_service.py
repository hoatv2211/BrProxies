from __future__ import annotations

import subprocess
import time
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from android_manager.tool_locator import android_sdk_roots, find_android_tool, find_java_home


class RunFn(Protocol):
    def __call__(self, args: list[str], **kwargs: object) -> object: ...


class PopenFn(Protocol):
    def __call__(self, args: list[str], **kwargs: object) -> object: ...

@dataclass(frozen=True)
class RunningAvd:
    name: str
    console_port: int
    serial: str

BLOAT_PACKAGES = [
    "com.google.android.apps.docs",
    "com.google.android.apps.maps",
    "com.google.android.apps.messaging",
    "com.google.android.apps.photos",
    "com.google.android.apps.tachyon",
    "com.google.android.apps.wellbeing",
    "com.google.android.calendar",
    "com.google.android.contacts",
    "com.google.android.gm",
    "com.google.android.keep",
    "com.google.android.videos",
    "com.google.android.youtube",
]


class AvdService:
    def __init__(
        self,
        data_dir: str,
        system_image: str = "system-images;android-35;google_apis;x86_64",
        device: str = "pixel_2",
        sdk_root: str | None = None,
        runner: RunFn | None = None,
        popen: PopenFn | None = None,
        which: Callable[[str], str | None] | None = None,
        java_home: str | None = None,
        avd_home: str | None = None,
    ) -> None:
        self.data_dir = data_dir
        self.system_image = system_image
        self.device = device
        self.sdk_root = Path(sdk_root) if sdk_root else None
        self.runner = runner or subprocess.run
        self.popen = popen or subprocess.Popen
        self.which = which or find_android_tool
        self.java_home = java_home or find_java_home()
        self.avd_home = Path(avd_home) if avd_home else Path(os.getenv("ANDROID_AVD_HOME", str(Path.home() / ".android" / "avd")))

    def serial(self, console_port: int) -> str:
        return f"emulator-{console_port}"

    def _tool(self, name: str) -> str:
        path = self.which(name)
        if not path:
            raise RuntimeError(f"{name} CLI not found on PATH")
        return path

    def _android_env(self) -> dict[str, str] | None:
        if not self.java_home:
            return None
        env = dict(os.environ)
        env["JAVA_HOME"] = self.java_home
        env["PATH"] = str(Path(self.java_home) / "bin") + os.pathsep + env.get("PATH", "")
        return env

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
            env=self._android_env(),
        )
        self.optimize_config(avd_name)

    def optimize_config(self, avd_name: str) -> None:
        avd_dir = self.avd_home / f"{avd_name}.avd"
        avd_dir.mkdir(parents=True, exist_ok=True)
        config_path = avd_dir / "config.ini"
        existing: dict[str, str] = {}
        if config_path.exists():
            for line in config_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                if "=" in line:
                    key, value = line.split("=", 1)
                    existing[key] = value
        existing.update(
            {
                "hw.lcd.width": "720",
                "hw.lcd.height": "1280",
                "hw.lcd.density": "320",
                "hw.ramSize": "2048",
                "vm.heapSize": "256",
                "hw.gpu.enabled": "yes",
                "hw.gpu.mode": "host",
                "hw.camera.back": "none",
                "hw.camera.front": "none",
                "hw.audioInput": "no",
                "hw.audioOutput": "no",
                "hw.gps": "no",
                "hw.sensors.orientation": "no",
                "hw.sensors.proximity": "no",
                "hw.sensors.magnetic_field": "no",
                "hw.trackBall": "no",
                "showDeviceFrame": "no",
                "disk.dataPartition.size": "4096M",
            }
        )
        existing.pop("fastboot.forceColdBoot", None)
        config_path.write_text("\n".join(f"{key}={value}" for key, value in sorted(existing.items())) + "\n", encoding="utf-8")

    def exists(self, avd_name: str) -> bool:
        result = self.runner([self._tool("avdmanager"), "list", "avd"], check=True, capture_output=True, text=True, env=self._android_env())
        output = str(getattr(result, "stdout", ""))
        return any(line.strip() == f"Name: {avd_name}" for line in output.splitlines())

    def resolve_system_image(self) -> str:
        configured = self.system_image
        parts = configured.split(";")
        if len(parts) == 4 and self._system_image_exists(parts[1], parts[2], parts[3]):
            return configured
        detected = self._installed_system_images()
        if detected:
            return detected[0]
        raise RuntimeError("No Android x86_64 system image is installed. Install an Android SDK x86_64 Google APIs system image in Android Studio SDK Manager.")

    def _installed_system_images(self) -> list[str]:
        roots = [self.sdk_root] if self.sdk_root else android_sdk_roots()
        images: list[str] = []
        flavor_rank = {"google_apis": 0, "default": 1, "google_apis_playstore": 2}
        for root in roots:
            if not root:
                continue
            base = root / "system-images"
            if not base.exists():
                continue
            for api_dir in base.iterdir():
                if not api_dir.is_dir():
                    continue
                for flavor_dir in api_dir.iterdir():
                    abi_dir = flavor_dir / "x86_64"
                    if (abi_dir / "package.xml").exists() or (abi_dir / "system.img").exists():
                        images.append(f"system-images;{api_dir.name};{flavor_dir.name};x86_64")
        return sorted(images, key=lambda value: (self._api_sort_key(value.split(";")[1]), flavor_rank.get(value.split(";")[2], 99)))

    def _api_sort_key(self, api: str) -> tuple[int, str]:
        try:
            return (-int(api.removeprefix("android-").split(".")[0]), api)
        except ValueError:
            return (0, api)

    def _system_image_exists(self, api: str, flavor: str, abi: str) -> bool:
        roots = [self.sdk_root] if self.sdk_root else android_sdk_roots()
        for root in roots:
            if not root:
                continue
            image_dir = root / "system-images" / api / flavor / abi
            if (image_dir / "package.xml").exists() or (image_dir / "system.img").exists():
                return True
        return False

    def start(self, avd_name: str, console_port: int) -> None:
        self.optimize_config(avd_name)
        if self.adb_state(console_port) == "offline":
            self.runner([self._tool("adb"), "kill-server"], check=False, capture_output=True, text=True)
            self.runner([self._tool("adb"), "start-server"], check=False, capture_output=True, text=True)
        args = [self._tool("emulator"), "-avd", avd_name, "-port", str(console_port), "-gpu", "host"]
        if self.which("scrcpy"):
            args.append("-no-window")
        args.extend(["-no-boot-anim", "-no-audio"])
        self.popen(args)
        serial = self.serial(console_port)
        self.runner([self._tool("adb"), "-s", serial, "wait-for-device"], check=True)
        deadline = time.time() + 90
        while True:
            try:
                result = self.runner([self._tool("adb"), "-s", serial, "shell", "getprop", "sys.boot_completed"], check=True, capture_output=True, text=True)
                if str(getattr(result, "stdout", "")).strip() == "1":
                    self.debloat(console_port)
                    return
            except subprocess.CalledProcessError:
                pass
            if time.time() > deadline:
                raise TimeoutError(f"Android emulator did not boot: {serial}")
            time.sleep(1)

    def running_avds(self) -> list[RunningAvd]:
        ports = self.running_ports()
        running: list[RunningAvd] = []
        for port in sorted(ports):
            serial = self.serial(port)
            name = self.avd_name_for_serial(serial)
            if name:
                running.append(RunningAvd(name=name, console_port=port, serial=serial))
        return running

    def running_ports(self) -> set[int]:
        try:
            result = self.runner([self._tool("adb"), "devices", "-l"], check=True, capture_output=True, text=True)
        except (RuntimeError, subprocess.CalledProcessError, FileNotFoundError):
            return set()
        ports: set[int] = set()
        for line in str(getattr(result, "stdout", "")).splitlines():
            match = re.match(r"^(emulator-(\d+))\s+device\b", line.strip())
            if not match:
                continue
            ports.add(int(match.group(2)))
        return ports

    def adb_state(self, console_port: int) -> str | None:
        serial = self.serial(console_port)
        try:
            result = self.runner([self._tool("adb"), "devices", "-l"], check=True, capture_output=True, text=True)
        except (RuntimeError, subprocess.CalledProcessError, FileNotFoundError):
            return None
        for line in str(getattr(result, "stdout", "")).splitlines():
            parts = line.strip().split()
            if len(parts) >= 2 and parts[0] == serial:
                return parts[1]
        return None

    def require_ready(self, console_port: int) -> None:
        state = self.adb_state(console_port)
        serial = self.serial(console_port)
        if state != "device":
            raise RuntimeError(f"Android device is not ready: {serial} is {state or 'missing'}")
        result = self.runner([self._tool("adb"), "-s", serial, "shell", "getprop", "sys.boot_completed"], check=True, capture_output=True, text=True)
        if str(getattr(result, "stdout", "")).strip() != "1":
            raise RuntimeError(f"Android device is not booted yet: {serial}")

    def avd_name_for_serial(self, serial: str) -> str | None:
        try:
            result = self.runner([self._tool("adb"), "-s", serial, "emu", "avd", "name"], check=True, capture_output=True, text=True)
        except (RuntimeError, subprocess.CalledProcessError, FileNotFoundError):
            return None
        for line in str(getattr(result, "stdout", "")).splitlines():
            value = line.strip()
            if value and value != "OK":
                return value
        return None

    def debloat(self, console_port: int) -> None:
        serial = self.serial(console_port)
        for package in BLOAT_PACKAGES:
            self.runner(
                [self._tool("adb"), "-s", serial, "shell", "pm", "disable-user", "--user", "0", package],
                check=False,
                capture_output=True,
                text=True,
            )

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
        self.require_ready(console_port)
        self.runner([self._tool("adb"), "-s", self.serial(console_port), "shell", "settings", "put", "global", "http_proxy", f"{host}:{port}"], check=True)

    def clear_http_proxy(self, console_port: int) -> None:
        self.require_ready(console_port)
        self.runner([self._tool("adb"), "-s", self.serial(console_port), "shell", "settings", "put", "global", "http_proxy", ":0"], check=True)

    def open_screen(self, console_port: int) -> bool:
        scrcpy = self.which("scrcpy")
        if not scrcpy:
            return False
        self.popen([scrcpy, "-s", self.serial(console_port), "--no-audio", "--max-size", "720", "--video-bit-rate", "4M"])
        return True
