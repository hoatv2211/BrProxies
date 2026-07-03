from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from android_manager.adb_service import AdbService
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


def _cfg() -> AndroidManagerConfig:
    return load_config()


def _store() -> AndroidStore:
    cfg = _cfg()
    Path(cfg.data_dir).mkdir(parents=True, exist_ok=True)
    return AndroidStore(str(Path(cfg.data_dir) / "android.sqlite3"))


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-") or "phone"


def _not_found(err: KeyError) -> HTTPException:
    return HTTPException(status_code=404, detail=f"unknown Android instance: {err.args[0]}")


def create_app() -> FastAPI:
    app = FastAPI(title="BrProxies Android Manager", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "name": "android-manager", "version": "0.1.0"}

    @app.get("/validate")
    def validate() -> dict[str, object]:
        return validate_host()

    @app.get("/instances")
    def list_instances() -> list[dict[str, object]]:
        return [asdict(item) for item in _store().list_instances()]

    @app.post("/instances")
    def create_instance(body: InstanceCreateRequest) -> dict[str, object]:
        cfg = _cfg()
        store = _store()
        port = allocate_adb_port(store.used_adb_ports(), cfg.adb_port_start, cfg.adb_port_end)
        safe = _slug(body.name)
        container_name = f"{cfg.container_prefix}{safe}-{port}"
        volume_name = f"{cfg.volume_prefix}{safe}_{port}_data".replace("-", "_")
        image = body.image or cfg.redroid_image
        DockerService(fake=cfg.fake_runtime).run_redroid(container_name, volume_name, port, image)
        item = store.create_instance(
            AndroidInstanceCreate(name=body.name, image=image, proxy_id=body.proxy_id),
            adb_port=port,
            container_name=container_name,
            volume_name=volume_name,
            status="running",
        )
        AdbService(fake=cfg.fake_runtime).connect(item.adb_host, item.adb_port)
        return asdict(item)

    @app.post("/instances/{instance_id}/start")
    def start_instance(instance_id: str) -> dict[str, object]:
        cfg = _cfg()
        store = _store()
        try:
            item = store.get_instance(instance_id)
            DockerService(fake=cfg.fake_runtime).start(item.container_name)
            AdbService(fake=cfg.fake_runtime).connect(item.adb_host, item.adb_port)
            return asdict(store.set_status(instance_id, "running"))
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/stop")
    def stop_instance(instance_id: str) -> dict[str, object]:
        cfg = _cfg()
        store = _store()
        try:
            item = store.get_instance(instance_id)
            DockerService(fake=cfg.fake_runtime).stop(item.container_name)
            return asdict(store.set_status(instance_id, "stopped"))
        except KeyError as e:
            raise _not_found(e)

    @app.delete("/instances/{instance_id}")
    def delete_instance(instance_id: str) -> dict[str, object]:
        cfg = _cfg()
        store = _store()
        try:
            item = store.get_instance(instance_id)
            DockerService(fake=cfg.fake_runtime).delete(item.container_name, item.volume_name)
            store.delete_instance(instance_id)
            return {"ok": True}
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/install-apk")
    def install_apk(instance_id: str, body: ApkInstallRequest) -> dict[str, object]:
        cfg = _cfg()
        try:
            item = _store().get_instance(instance_id)
            AdbService(fake=cfg.fake_runtime).install_apk(item.adb_host, item.adb_port, body.apk_path)
            return {"ok": True}
        except KeyError as e:
            raise _not_found(e)

    @app.get("/instances/{instance_id}/screenshot")
    def screenshot(instance_id: str):
        cfg = _cfg()
        try:
            item = _store().get_instance(instance_id)
            out = Path(cfg.data_dir) / "screenshots" / f"{instance_id}.png"
            AdbService(fake=cfg.fake_runtime).screenshot(item.adb_host, item.adb_port, str(out))
            return FileResponse(str(out), media_type="image/png")
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/set-proxy")
    def set_proxy(instance_id: str, body: SetProxyRequest) -> dict[str, object]:
        cfg = _cfg()
        store = _store()
        try:
            item = store.get_instance(instance_id)
            AdbService(fake=cfg.fake_runtime).set_http_proxy(item.adb_host, item.adb_port, body.host, body.port)
            return asdict(store.set_proxy(instance_id, body.proxy_id or f"{body.host}:{body.port}"))
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/clear-proxy")
    def clear_proxy(instance_id: str) -> dict[str, object]:
        cfg = _cfg()
        store = _store()
        try:
            item = store.get_instance(instance_id)
            AdbService(fake=cfg.fake_runtime).clear_http_proxy(item.adb_host, item.adb_port)
            return asdict(store.set_proxy(instance_id, None))
        except KeyError as e:
            raise _not_found(e)

    @app.post("/instances/{instance_id}/open-screen")
    def open_screen(instance_id: str) -> dict[str, object]:
        cfg = _cfg()
        try:
            item = _store().get_instance(instance_id)
            ScrcpyService(fake=cfg.fake_runtime).open_screen(item.adb_host, item.adb_port)
            return {"ok": True}
        except KeyError as e:
            raise _not_found(e)

    return app
