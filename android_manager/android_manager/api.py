from __future__ import annotations

import re
import subprocess
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from android_manager.adb_service import AdbService
from android_manager.avd_service import AvdService
from android_manager.config import AndroidManagerConfig, load_config
from android_manager.docker_service import DockerService
from android_manager.models import AndroidInstanceCreate
from android_manager.ports import allocate_adb_port
from android_manager.scrcpy_service import ScrcpyService
from android_manager.storage import AndroidStore
from android_manager.validator import validate_host


class InstanceCreateRequest(BaseModel):
    name: str
    image: str | None = None
    proxy_id: str | None = None


class ApkInstallRequest(BaseModel):
    apk_path: str


class SetProxyRequest(BaseModel):
    host: str
    port: int
    proxy_id: str | None = None


def _cfg(config_path: str | None = None) -> AndroidManagerConfig:
    return load_config(config_path)


def _store(config_path: str | None = None) -> AndroidStore:
    cfg = _cfg(config_path)
    Path(cfg.data_dir).mkdir(parents=True, exist_ok=True)
    return AndroidStore(str(Path(cfg.data_dir) / "android.sqlite3"))


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-") or "phone"


def _not_found(err: KeyError) -> HTTPException:
    return HTTPException(status_code=404, detail=f"unknown Android instance: {err.args[0]}")

def _runtime(cfg: AndroidManagerConfig) -> str:
    return "fake" if cfg.fake_runtime else cfg.runtime

def _is_fake(cfg: AndroidManagerConfig) -> bool:
    return cfg.fake_runtime or cfg.runtime == "fake"

def _allocate_port(store: AndroidStore, cfg: AndroidManagerConfig) -> int:
    if _runtime(cfg) != "windows_avd":
        return allocate_adb_port(store.used_adb_ports(), cfg.adb_port_start, cfg.adb_port_end)
    used = store.used_adb_ports()
    start = cfg.adb_port_start if cfg.adb_port_start % 2 == 0 else cfg.adb_port_start + 1
    for port in range(start, cfg.adb_port_end + 1, 2):
        if port not in used:
            return port
    raise HTTPException(status_code=409, detail="no free Android emulator ports available")

def _avd(cfg: AndroidManagerConfig) -> AvdService:
    return AvdService(cfg.data_dir, cfg.avd_system_image, cfg.avd_device)

def _sync_windows_avds(store: AndroidStore, cfg: AndroidManagerConfig) -> None:
    service = _avd(cfg)
    running_ports = service.running_ports()
    for item in store.list_instances():
        next_status = "running" if item.adb_port in running_ports else "stopped"
        if item.status != next_status:
            store.set_status(item.id, next_status)
    for running in service.running_avds():
        if not running.name.startswith("brproxies_android_"):
            continue
        store.adopt_instance(
            name=running.name,
            image=cfg.avd_system_image,
            adb_port=running.console_port,
            container_name=running.name,
            volume_name=f"{running.name}_data",
        )

def _runtime_http_error(err: Exception) -> HTTPException:
    if isinstance(err, subprocess.CalledProcessError):
        output = "\n".join(str(part) for part in (err.stderr, err.stdout) if part)
        return HTTPException(status_code=400, detail=output or str(err))
    return HTTPException(status_code=400, detail=str(err))

def _friendly_avd_name(avd_name: str) -> str:
    name = avd_name.removeprefix("brproxies_android_")
    return name.replace("_", "-") or avd_name


def create_app(config_path: str | None = None) -> FastAPI:
    app = FastAPI(title="BrProxies Android Manager", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "name": "android-manager", "version": "0.1.0"}

    @app.get("/validate")
    def validate() -> dict[str, object]:
        cfg = _cfg(config_path)
        return validate_host(_runtime(cfg))

    @app.get("/instances")
    def list_instances() -> list[dict[str, object]]:
        cfg = _cfg(config_path)
        store = _store(config_path)
        if _runtime(cfg) == "windows_avd":
            _sync_windows_avds(store, cfg)
        return [asdict(item) for item in store.list_instances()]

    @app.post("/instances")
    def create_instance(body: InstanceCreateRequest) -> dict[str, object]:
        cfg = _cfg(config_path)
        store = _store(config_path)
        port = _allocate_port(store, cfg)
        safe = _slug(body.name)
        runtime = _runtime(cfg)
        if runtime == "windows_avd":
            container_name = f"brproxies_android_{safe}_{port}".replace("-", "_")
            volume_name = f"{container_name}_data"
            if store.get_by_container_name(container_name) is not None:
                raise HTTPException(status_code=409, detail="Android instance already exists. Use Import devices to attach existing AVDs.")
            image = cfg.avd_system_image
            service = _avd(cfg)
            try:
                service.create(container_name)
                service.start(container_name, port)
            except (RuntimeError, subprocess.CalledProcessError, TimeoutError) as e:
                raise _runtime_http_error(e)
        else:
            container_name = f"{cfg.container_prefix}{safe}-{port}"
            volume_name = f"{cfg.volume_prefix}{safe}_{port}_data".replace("-", "_")
            image = body.image or cfg.redroid_image
            DockerService(fake=_is_fake(cfg)).run_redroid(container_name, volume_name, port, image)
        try:
            item = store.create_instance(
                AndroidInstanceCreate(name=body.name, image=image, proxy_id=body.proxy_id),
                adb_port=port,
                container_name=container_name,
                volume_name=volume_name,
                status="running",
            )
        except Exception as e:
            if "UNIQUE constraint failed" in str(e):
                raise HTTPException(status_code=409, detail="Android instance already exists. Use Import devices to attach existing AVDs.")
            raise
        if runtime != "windows_avd":
            AdbService(fake=_is_fake(cfg)).connect(item.adb_host, item.adb_port)
        return asdict(item)

    @app.post("/instances/import-avds")
    def import_avds() -> list[dict[str, object]]:
        cfg = _cfg(config_path)
        if _runtime(cfg) != "windows_avd":
            raise HTTPException(status_code=400, detail="AVD import is only available for windows_avd runtime")
        store = _store(config_path)
        service = _avd(cfg)
        running_by_name = {item.name: item.console_port for item in service.running_avds()}
        imported = []
        for avd_name, running_port in sorted(running_by_name.items()):
            existing = store.get_by_container_name(avd_name)
            if existing:
                port = existing.adb_port
            else:
                port = running_port
            item = store.adopt_instance(
                name=_friendly_avd_name(avd_name),
                image=cfg.avd_system_image,
                adb_port=port,
                container_name=avd_name,
                volume_name=f"{avd_name}_data",
                status="running",
            )
            imported.append(asdict(item))
        return imported

    @app.post("/instances/{instance_id}/start")
    def start_instance(instance_id: str) -> dict[str, object]:
        cfg = _cfg(config_path)
        store = _store(config_path)
        try:
            item = store.get_instance(instance_id)
            if _runtime(cfg) == "windows_avd":
                if item.adb_port % 2 != 0:
                    item = store.set_adb_port(instance_id, _allocate_port(store, cfg))
                service = _avd(cfg)
                try:
                    if not service.exists(item.container_name):
                        service.create(item.container_name)
                    service.start(item.container_name, item.adb_port)
                except (RuntimeError, subprocess.CalledProcessError, TimeoutError) as e:
                    raise _runtime_http_error(e)
            else:
                DockerService(fake=_is_fake(cfg)).start(item.container_name)
                AdbService(fake=_is_fake(cfg)).connect(item.adb_host, item.adb_port)
            return asdict(store.set_status(instance_id, "running"))
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/stop")
    def stop_instance(instance_id: str) -> dict[str, object]:
        cfg = _cfg(config_path)
        store = _store(config_path)
        try:
            item = store.get_instance(instance_id)
            if _runtime(cfg) == "windows_avd":
                _avd(cfg).stop(item.adb_port)
            else:
                DockerService(fake=_is_fake(cfg)).stop(item.container_name)
            return asdict(store.set_status(instance_id, "stopped"))
        except KeyError as e:
            raise _not_found(e)

    @app.delete("/instances/{instance_id}")
    def delete_instance(instance_id: str) -> dict[str, object]:
        cfg = _cfg(config_path)
        store = _store(config_path)
        try:
            item = store.get_instance(instance_id)
            if _runtime(cfg) == "windows_avd":
                _avd(cfg).delete(item.container_name)
            else:
                DockerService(fake=_is_fake(cfg)).delete(item.container_name, item.volume_name)
            store.delete_instance(instance_id)
            return {"ok": True}
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/install-apk")
    def install_apk(instance_id: str, body: ApkInstallRequest) -> dict[str, object]:
        cfg = _cfg(config_path)
        try:
            item = _store(config_path).get_instance(instance_id)
            if _runtime(cfg) == "windows_avd":
                _avd(cfg).install_apk(item.adb_port, body.apk_path)
            else:
                AdbService(fake=_is_fake(cfg)).install_apk(item.adb_host, item.adb_port, body.apk_path)
            return {"ok": True}
        except KeyError as e:
            raise _not_found(e)

    @app.get("/instances/{instance_id}/screenshot")
    def screenshot(instance_id: str):
        cfg = _cfg(config_path)
        try:
            item = _store(config_path).get_instance(instance_id)
            out = Path(cfg.data_dir) / "screenshots" / f"{instance_id}.png"
            if _runtime(cfg) == "windows_avd":
                _avd(cfg).screenshot(item.adb_port, str(out))
            else:
                AdbService(fake=_is_fake(cfg)).screenshot(item.adb_host, item.adb_port, str(out))
            return FileResponse(str(out), media_type="image/png")
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/set-proxy")
    def set_proxy(instance_id: str, body: SetProxyRequest) -> dict[str, object]:
        cfg = _cfg(config_path)
        store = _store(config_path)
        try:
            item = store.get_instance(instance_id)
            try:
                if _runtime(cfg) == "windows_avd":
                    _avd(cfg).set_http_proxy(item.adb_port, body.host, body.port)
                else:
                    AdbService(fake=_is_fake(cfg)).set_http_proxy(item.adb_host, item.adb_port, body.host, body.port)
            except (RuntimeError, subprocess.CalledProcessError, TimeoutError) as e:
                raise _runtime_http_error(e)
            return asdict(store.set_proxy(instance_id, body.proxy_id or f"{body.host}:{body.port}"))
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/clear-proxy")
    def clear_proxy(instance_id: str) -> dict[str, object]:
        cfg = _cfg(config_path)
        store = _store(config_path)
        try:
            item = store.get_instance(instance_id)
            try:
                if _runtime(cfg) == "windows_avd":
                    _avd(cfg).clear_http_proxy(item.adb_port)
                else:
                    AdbService(fake=_is_fake(cfg)).clear_http_proxy(item.adb_host, item.adb_port)
            except (RuntimeError, subprocess.CalledProcessError, TimeoutError) as e:
                raise _runtime_http_error(e)
            return asdict(store.set_proxy(instance_id, None))
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/open-screen")
    def open_screen(instance_id: str) -> dict[str, object]:
        cfg = _cfg(config_path)
        try:
            item = _store(config_path).get_instance(instance_id)
            if _runtime(cfg) == "windows_avd":
                opened = _avd(cfg).open_screen(item.adb_port)
                if opened:
                    return {"ok": True, "opened": True}
                return {"ok": True, "opened": True, "message": "scrcpy is not installed; Android Emulator window is opened by start"}
            ScrcpyService(fake=_is_fake(cfg)).open_screen(item.adb_host, item.adb_port)
            if _is_fake(cfg):
                return {"ok": True, "opened": False, "message": "fake runtime active; no Android window opened"}
            return {"ok": True, "opened": True}
        except KeyError as e:
            raise _not_found(e)

    return app
