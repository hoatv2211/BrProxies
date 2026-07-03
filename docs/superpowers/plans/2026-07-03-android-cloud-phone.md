# Android Cloud Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Android instance management to BrProxies, with Windows-friendly app development and real ReDroid execution on a Linux Android host.

**Architecture:** Keep Android runtime outside the desktop app. BrProxies adds an `Android` tab and Tauri bridge commands; a focused `android_manager` sidecar/API manages Docker/ReDroid, ADB, APK install, screenshots, scrcpy, and proxy assignment on a Linux host. Windows can develop and test UI/API flows against a fake manager or remote Linux host, while ReDroid production remains Linux-only.

**Tech Stack:** Tauri 2/Rust, React/TypeScript/Vite, existing axum local API, Python 3.11+ FastAPI sidecar for `android_manager`, Docker, ReDroid, ADB, scrcpy, pytest, httpx.

---

## Scope Decision

MVP includes:

- Register one Android host.
- Validate host capability for ReDroid.
- Create/start/stop/delete Android instances.
- Allocate ADB ports from `5555-5999`.
- Persist instance metadata.
- Install APK into an instance.
- Capture screenshot from an instance.
- Open instance screen with `scrcpy` on the host or local machine where ADB can reach it.
- Assign/clear basic Android global HTTP proxy.
- Expose local automation API under `/android/*`.
- Add launcher `Android` tab.

MVP excludes:

- Production WebRTC streaming.
- Billing/team/RBAC.
- Full-device anti-detect Android fingerprinting.
- Guaranteed SOCKS/VPN full traffic capture.
- Google Play Services compatibility guarantee.
- Windows-native ReDroid runtime.

## File Map

- Create `android_manager/pyproject.toml`: package metadata and dev dependencies.
- Create `android_manager/android_manager/config.py`: host config, port range, image defaults.
- Create `android_manager/android_manager/models.py`: typed records for hosts, instances, APK install, screenshots, validation.
- Create `android_manager/android_manager/storage.py`: SQLite metadata storage for MVP.
- Create `android_manager/android_manager/ports.py`: deterministic port allocation.
- Create `android_manager/android_manager/docker_service.py`: Docker CLI wrapper with fixed command allowlist.
- Create `android_manager/android_manager/adb_service.py`: ADB wrapper for connect, install, screenshot, proxy.
- Create `android_manager/android_manager/scrcpy_service.py`: screen opener wrapper.
- Create `android_manager/android_manager/validator.py`: host capability checks.
- Create `android_manager/android_manager/api.py`: FastAPI app and routes.
- Create `android_manager/android_manager/__main__.py`: CLI entrypoint.
- Create `android_manager/tests/*.py`: tests for config, ports, validators, API behavior.
- Create `android_manager/README.md`: Linux host setup and Windows dev notes.
- Create `scripts/android-host-validator.sh`: manual Linux host validator.
- Modify `src-tauri/src/store.rs`: add Android manager config path.
- Modify `src-tauri/src/settings.rs`: add Android manager host/port/token settings.
- Create `src-tauri/src/android.rs`: sidecar status/start/stop and HTTP proxy commands.
- Modify `src-tauri/src/api.rs`: expose `/android/*` routes through current JWT API.
- Modify `src-tauri/src/lib.rs`: register `android` module and commands.
- Modify `src/App.tsx`: add `Android` section, host status, instance table, actions.
- Modify `src/App.css`: add scoped Android table/status styles only where existing styles are insufficient.
- Modify `openapi.yaml`: document `/android/*` local API routes.

---

### Task 1: Linux Host Validator Script

**Files:**
- Create: `scripts/android-host-validator.sh`
- Create: `android_manager/README.md`

- [ ] **Step 1: Add manual validator script**

Create `scripts/android-host-validator.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE="${REDROID_IMAGE:-redroid/redroid:12.0.0-latest}"
NAME="${REDROID_TEST_NAME:-brproxies-redroid-validator}"
VOLUME="${REDROID_TEST_VOLUME:-brproxies_redroid_validator_data}"
PORT="${REDROID_TEST_PORT:-5555}"

echo "== BrProxies Android host validator =="
echo "image=$IMAGE name=$NAME port=$PORT"

command -v docker >/dev/null || { echo "FAIL docker missing"; exit 1; }
command -v adb >/dev/null || { echo "FAIL adb missing"; exit 1; }
command -v scrcpy >/dev/null || echo "WARN scrcpy missing; screen-open will not work"

docker info >/dev/null || { echo "FAIL docker daemon unavailable"; exit 1; }

if [ ! -e /dev/binder ] || [ ! -e /dev/hwbinder ] || [ ! -e /dev/vndbinder ]; then
  echo "WARN binder devices missing; trying modprobe"
  sudo modprobe binder_linux devices="binder,hwbinder,vndbinder" || true
  sudo modprobe ashmem_linux || true
fi

[ -e /dev/binder ] || { echo "FAIL /dev/binder missing"; exit 1; }
[ -e /dev/hwbinder ] || { echo "FAIL /dev/hwbinder missing"; exit 1; }
[ -e /dev/vndbinder ] || { echo "FAIL /dev/vndbinder missing"; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null

docker run -d --privileged \
  --name "$NAME" \
  -v "$VOLUME:/data" \
  -p "127.0.0.1:${PORT}:5555" \
  "$IMAGE" >/dev/null

echo "waiting for Android boot..."
for i in $(seq 1 60); do
  adb connect "127.0.0.1:${PORT}" >/dev/null || true
  BOOTED="$(adb -s "127.0.0.1:${PORT}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  if [ "$BOOTED" = "1" ]; then
    echo "PASS boot_completed"
    break
  fi
  sleep 2
done

BOOTED="$(adb -s "127.0.0.1:${PORT}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
[ "$BOOTED" = "1" ] || { docker logs "$NAME" --tail=120; echo "FAIL Android did not boot"; exit 1; }

adb -s "127.0.0.1:${PORT}" exec-out screencap -p >/tmp/brproxies-redroid-validator.png
[ -s /tmp/brproxies-redroid-validator.png ] || { echo "FAIL screenshot empty"; exit 1; }

echo "PASS screenshot /tmp/brproxies-redroid-validator.png"
echo "PASS host can run ReDroid MVP"
echo "cleanup: docker rm -f $NAME && docker volume rm $VOLUME"
```

- [ ] **Step 2: Document host setup**

Create `android_manager/README.md`:

```markdown
# Android Manager

Android Manager controls ReDroid containers on a Linux host for BrProxies.

## Supported MVP Topology

- BrProxies may run on Windows, macOS, or Linux.
- ReDroid containers run on Ubuntu 22.04/24.04 Linux host.
- Windows development can use a fake manager or remote Ubuntu host.
- Windows-native ReDroid is not required for MVP.

## Linux Host Packages

```bash
sudo apt update
sudo apt install -y docker.io adb scrcpy python3 python3-venv python3-pip curl git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and back in after `usermod`.

## Kernel Devices

```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux || true
ls /dev/binder /dev/hwbinder /dev/vndbinder
```

## Validator

```bash
bash scripts/android-host-validator.sh
```

The validator must pass before building the UI against real ReDroid.
```

- [ ] **Step 3: Run validator shell syntax check**

Run on Windows repo shell if `bash` exists:

```powershell
bash -n scripts/android-host-validator.sh
```

Expected: exit code `0`.

- [ ] **Step 4: Commit**

```bash
git add scripts/android-host-validator.sh android_manager/README.md
git commit -m "docs: add Android host validator"
```

---

### Task 2: Android Manager Package Skeleton

**Files:**
- Create: `android_manager/pyproject.toml`
- Create: `android_manager/android_manager/__init__.py`
- Create: `android_manager/android_manager/config.py`
- Create: `android_manager/tests/test_config.py`

- [ ] **Step 1: Write config tests**

Create `android_manager/tests/test_config.py`:

```python
from android_manager.config import AndroidManagerConfig, load_config


def test_default_config_values():
    cfg = AndroidManagerConfig()
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 40327
    assert cfg.redroid_image == "redroid/redroid:12.0.0-latest"
    assert cfg.adb_port_start == 5555
    assert cfg.adb_port_end == 5999
    assert cfg.container_prefix == "brproxies-android-"
    assert cfg.volume_prefix == "brproxies_android_"


def test_load_config_from_json_and_env(tmp_path, monkeypatch):
    path = tmp_path / "android-manager.json"
    path.write_text(
        '{"host":"127.0.0.2","port":41027,"adb_port_start":5600,"adb_port_end":5602}',
        encoding="utf-8",
    )
    monkeypatch.setenv("ANDROID_MANAGER_PORT", "42027")
    monkeypatch.setenv("ANDROID_MANAGER_REDROID_IMAGE", "redroid/redroid:13.0.0-latest")
    cfg = load_config(str(path))
    assert cfg.host == "127.0.0.2"
    assert cfg.port == 42027
    assert cfg.redroid_image == "redroid/redroid:13.0.0-latest"
    assert cfg.adb_port_start == 5600
    assert cfg.adb_port_end == 5602
```

- [ ] **Step 2: Run failing test**

```bash
cd android_manager
python -m pytest tests/test_config.py -v
```

Expected: FAIL because package does not exist.

- [ ] **Step 3: Add package metadata**

Create `android_manager/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=69", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "brproxies-android-manager"
version = "0.1.0"
description = "ReDroid Android instance manager for BrProxies"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115,<1",
  "uvicorn[standard]>=0.30,<1",
  "pydantic>=2,<3",
  "python-dotenv>=1,<2",
]

[project.optional-dependencies]
dev = [
  "pytest>=8,<9",
  "pytest-asyncio>=0.23,<1",
  "httpx>=0.27,<1",
]

[project.scripts]
brproxies-android-manager = "android_manager.__main__:main"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

Create `android_manager/android_manager/__init__.py`:

```python
__all__ = ["__version__"]
__version__ = "0.1.0"
```

- [ ] **Step 4: Add config implementation**

Create `android_manager/android_manager/config.py`:

```python
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

    @classmethod
    def from_mapping(cls, data: dict[str, Any]) -> "AndroidManagerConfig":
        return cls(
            host=str(data.get("host", cls.host)),
            port=int(data.get("port", cls.port)),
            redroid_image=str(data.get("redroid_image", cls.redroid_image)),
            adb_port_start=int(data.get("adb_port_start", cls.adb_port_start)),
            adb_port_end=int(data.get("adb_port_end", cls.adb_port_end)),
            container_prefix=str(data.get("container_prefix", cls.container_prefix)),
            volume_prefix=str(data.get("volume_prefix", cls.volume_prefix)),
            data_dir=str(data.get("data_dir", cls.data_dir)),
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
    }
    for env_name, field_name in env_map.items():
        value = os.getenv(env_name)
        if value is not None:
            data[field_name] = value
    return AndroidManagerConfig.from_mapping(data)
```

- [ ] **Step 5: Run test**

```bash
cd android_manager
python -m pytest tests/test_config.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android_manager/pyproject.toml android_manager/android_manager/__init__.py android_manager/android_manager/config.py android_manager/tests/test_config.py
git commit -m "feat: scaffold Android manager config"
```

---

### Task 3: Metadata Models, Storage, And Port Allocation

**Files:**
- Create: `android_manager/android_manager/models.py`
- Create: `android_manager/android_manager/storage.py`
- Create: `android_manager/android_manager/ports.py`
- Create: `android_manager/tests/test_ports.py`
- Create: `android_manager/tests/test_storage.py`

- [ ] **Step 1: Write port tests**

Create `android_manager/tests/test_ports.py`:

```python
import pytest

from android_manager.ports import allocate_adb_port


def test_allocate_first_free_port():
    assert allocate_adb_port({5555, 5556}, 5555, 5558) == 5557


def test_allocate_raises_when_range_full():
    with pytest.raises(RuntimeError, match="no free ADB port"):
        allocate_adb_port({5555, 5556}, 5555, 5556)
```

- [ ] **Step 2: Add model and storage tests**

Create `android_manager/tests/test_storage.py`:

```python
from android_manager.models import AndroidInstanceCreate
from android_manager.storage import AndroidStore


def test_create_and_list_instance(tmp_path):
    store = AndroidStore(str(tmp_path / "android.sqlite3"))
    created = store.create_instance(
        AndroidInstanceCreate(name="phone-1", image="redroid/redroid:12.0.0-latest", proxy_id=None),
        adb_port=5555,
        container_name="brproxies-android-phone-1",
        volume_name="brproxies_android_phone_1_data",
    )
    assert created.name == "phone-1"
    assert created.status == "created"
    assert store.list_instances()[0].id == created.id
```

- [ ] **Step 3: Run failing tests**

```bash
cd android_manager
python -m pytest tests/test_ports.py tests/test_storage.py -v
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Add implementation**

Create `android_manager/android_manager/ports.py`:

```python
def allocate_adb_port(used_ports: set[int], start: int, end: int) -> int:
    for port in range(start, end + 1):
        if port not in used_ports:
            return port
    raise RuntimeError(f"no free ADB port in range {start}-{end}")
```

Create `android_manager/android_manager/models.py`:

```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class AndroidInstanceCreate:
    name: str
    image: str
    proxy_id: str | None = None


@dataclass(slots=True)
class AndroidInstance:
    id: str
    name: str
    image: str
    adb_host: str
    adb_port: int
    container_name: str
    volume_name: str
    status: str
    proxy_id: str | None
    created_at: str
    updated_at: str
```

Create `android_manager/android_manager/storage.py`:

```python
from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone

from android_manager.models import AndroidInstance, AndroidInstanceCreate


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AndroidStore:
    def __init__(self, path: str) -> None:
        self.path = path
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                create table if not exists android_instances (
                  id text primary key,
                  name text not null,
                  image text not null,
                  adb_host text not null,
                  adb_port integer not null unique,
                  container_name text not null unique,
                  volume_name text not null unique,
                  status text not null,
                  proxy_id text,
                  created_at text not null,
                  updated_at text not null
                )
                """
            )

    def list_instances(self) -> list[AndroidInstance]:
        with self._connect() as conn:
            rows = conn.execute("select * from android_instances order by created_at desc").fetchall()
        return [AndroidInstance(**dict(row)) for row in rows]

    def used_adb_ports(self) -> set[int]:
        return {item.adb_port for item in self.list_instances()}

    def create_instance(
        self,
        body: AndroidInstanceCreate,
        adb_port: int,
        container_name: str,
        volume_name: str,
    ) -> AndroidInstance:
        instance_id = uuid.uuid4().hex
        now = _now()
        item = AndroidInstance(
            id=instance_id,
            name=body.name,
            image=body.image,
            adb_host="127.0.0.1",
            adb_port=adb_port,
            container_name=container_name,
            volume_name=volume_name,
            status="created",
            proxy_id=body.proxy_id,
            created_at=now,
            updated_at=now,
        )
        with self._connect() as conn:
            conn.execute(
                """
                insert into android_instances
                (id, name, image, adb_host, adb_port, container_name, volume_name, status, proxy_id, created_at, updated_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id,
                    item.name,
                    item.image,
                    item.adb_host,
                    item.adb_port,
                    item.container_name,
                    item.volume_name,
                    item.status,
                    item.proxy_id,
                    item.created_at,
                    item.updated_at,
                ),
            )
        return item
```

- [ ] **Step 5: Run tests**

```bash
cd android_manager
python -m pytest tests/test_ports.py tests/test_storage.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android_manager/android_manager/models.py android_manager/android_manager/storage.py android_manager/android_manager/ports.py android_manager/tests/test_ports.py android_manager/tests/test_storage.py
git commit -m "feat: add Android instance metadata storage"
```

---

### Task 4: Host Validation API

**Files:**
- Create: `android_manager/android_manager/validator.py`
- Create: `android_manager/android_manager/api.py`
- Create: `android_manager/android_manager/__main__.py`
- Create: `android_manager/tests/test_api_validation.py`

- [ ] **Step 1: Write API validation test**

Create `android_manager/tests/test_api_validation.py`:

```python
from fastapi.testclient import TestClient

from android_manager.api import create_app


def test_health_endpoint():
    client = TestClient(create_app())
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert resp.json()["name"] == "android-manager"


def test_validate_endpoint_returns_checks():
    client = TestClient(create_app())
    resp = client.get("/validate")
    assert resp.status_code == 200
    body = resp.json()
    assert "checks" in body
    assert {item["name"] for item in body["checks"]} >= {"docker", "adb", "binder"}
```

- [ ] **Step 2: Run failing test**

```bash
cd android_manager
python -m pytest tests/test_api_validation.py -v
```

Expected: FAIL because API does not exist.

- [ ] **Step 3: Add API and validator**

Create `android_manager/android_manager/validator.py`:

```python
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
```

Create `android_manager/android_manager/api.py`:

```python
from __future__ import annotations

from fastapi import FastAPI

from android_manager.validator import validate_host


def create_app() -> FastAPI:
    app = FastAPI(title="BrProxies Android Manager", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "name": "android-manager", "version": "0.1.0"}

    @app.get("/validate")
    def validate() -> dict[str, object]:
        return validate_host()

    return app
```

Create `android_manager/android_manager/__main__.py`:

```python
from __future__ import annotations

import argparse

import uvicorn

from android_manager.api import create_app
from android_manager.config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(prog="brproxies-android-manager")
    parser.add_argument("serve", nargs="?", default="serve")
    parser.add_argument("--config", default=None)
    args = parser.parse_args()
    cfg = load_config(args.config)
    uvicorn.run(create_app(), host=cfg.host, port=cfg.port)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test**

```bash
cd android_manager
python -m pytest tests/test_api_validation.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android_manager/android_manager/validator.py android_manager/android_manager/api.py android_manager/android_manager/__main__.py android_manager/tests/test_api_validation.py
git commit -m "feat: add Android manager validation API"
```

---

### Task 5: Instance Lifecycle Service

**Files:**
- Create: `android_manager/android_manager/docker_service.py`
- Create: `android_manager/android_manager/adb_service.py`
- Modify: `android_manager/android_manager/api.py`
- Modify: `android_manager/android_manager/storage.py`
- Create: `android_manager/tests/test_api_instances.py`

- [ ] **Step 1: Write API instance tests with fake services**

Create `android_manager/tests/test_api_instances.py`:

```python
from fastapi.testclient import TestClient

from android_manager.api import create_app


def test_create_and_list_instance(tmp_path, monkeypatch):
    monkeypatch.setenv("ANDROID_MANAGER_DATA_DIR", str(tmp_path))
    client = TestClient(create_app())
    resp = client.post("/instances", json={"name": "phone-1", "image": "redroid/redroid:12.0.0-latest"})
    assert resp.status_code == 200
    created = resp.json()
    assert created["name"] == "phone-1"
    assert created["adb_port"] == 5555
    assert created["status"] in {"created", "running"}

    listed = client.get("/instances").json()
    assert listed[0]["id"] == created["id"]
```

- [ ] **Step 2: Run failing test**

```bash
cd android_manager
python -m pytest tests/test_api_instances.py -v
```

Expected: FAIL because `/instances` is not implemented.

- [ ] **Step 3: Add service wrappers**

Create `android_manager/android_manager/docker_service.py`:

```python
from __future__ import annotations

import subprocess


class DockerService:
    def run_redroid(self, container_name: str, volume_name: str, adb_port: int, image: str) -> None:
        subprocess.run(["docker", "volume", "create", volume_name], check=True)
        subprocess.run(
            [
                "docker", "run", "-d", "--privileged",
                "--name", container_name,
                "-v", f"{volume_name}:/data",
                "-p", f"127.0.0.1:{adb_port}:5555",
                image,
            ],
            check=True,
        )

    def start(self, container_name: str) -> None:
        subprocess.run(["docker", "start", container_name], check=True)

    def stop(self, container_name: str) -> None:
        subprocess.run(["docker", "stop", container_name], check=True)

    def delete(self, container_name: str, volume_name: str) -> None:
        subprocess.run(["docker", "rm", "-f", container_name], check=False)
        subprocess.run(["docker", "volume", "rm", volume_name], check=False)
```

Create `android_manager/android_manager/adb_service.py`:

```python
from __future__ import annotations

import subprocess
from pathlib import Path


class AdbService:
    def serial(self, adb_host: str, adb_port: int) -> str:
        return f"{adb_host}:{adb_port}"

    def connect(self, adb_host: str, adb_port: int) -> None:
        subprocess.run(["adb", "connect", self.serial(adb_host, adb_port)], check=False)

    def install_apk(self, adb_host: str, adb_port: int, apk_path: str) -> None:
        subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "install", "-r", apk_path], check=True)

    def screenshot(self, adb_host: str, adb_port: int, output_path: str) -> None:
        with Path(output_path).open("wb") as out:
            subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "exec-out", "screencap", "-p"], stdout=out, check=True)

    def set_http_proxy(self, adb_host: str, adb_port: int, host: str, port: int) -> None:
        subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "shell", "settings", "put", "global", "http_proxy", f"{host}:{port}"], check=True)

    def clear_http_proxy(self, adb_host: str, adb_port: int) -> None:
        subprocess.run(["adb", "-s", self.serial(adb_host, adb_port), "shell", "settings", "put", "global", "http_proxy", ":0"], check=True)
```

- [ ] **Step 4: Add API routes**

Modify `android_manager/android_manager/api.py` to include:

```python
from pathlib import Path

from pydantic import BaseModel

from android_manager.config import load_config
from android_manager.models import AndroidInstanceCreate
from android_manager.ports import allocate_adb_port
from android_manager.storage import AndroidStore


class InstanceCreateRequest(BaseModel):
    name: str
    image: str | None = None
    proxy_id: str | None = None


def _store() -> AndroidStore:
    cfg = load_config()
    Path(cfg.data_dir).mkdir(parents=True, exist_ok=True)
    return AndroidStore(str(Path(cfg.data_dir) / "android.sqlite3"))
```

Inside `create_app()` add:

```python
    @app.get("/instances")
    def list_instances() -> list[dict[str, object]]:
        return [item.__dict__ for item in _store().list_instances()]

    @app.post("/instances")
    def create_instance(body: InstanceCreateRequest) -> dict[str, object]:
        cfg = load_config()
        store = _store()
        port = allocate_adb_port(store.used_adb_ports(), cfg.adb_port_start, cfg.adb_port_end)
        safe_name = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in body.name.lower()).strip("-") or "phone"
        container_name = f"{cfg.container_prefix}{safe_name}-{port}"
        volume_name = f"{cfg.volume_prefix}{safe_name}_{port}_data".replace("-", "_")
        created = store.create_instance(
            AndroidInstanceCreate(name=body.name, image=body.image or cfg.redroid_image, proxy_id=body.proxy_id),
            adb_port=port,
            container_name=container_name,
            volume_name=volume_name,
        )
        return created.__dict__
```

- [ ] **Step 5: Run tests**

```bash
cd android_manager
python -m pytest tests/test_api_instances.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android_manager/android_manager/docker_service.py android_manager/android_manager/adb_service.py android_manager/android_manager/api.py android_manager/android_manager/storage.py android_manager/tests/test_api_instances.py
git commit -m "feat: add Android instance lifecycle API"
```

---

### Task 6: Tauri Android Bridge

**Files:**
- Modify: `src-tauri/src/store.rs`
- Modify: `src-tauri/src/settings.rs`
- Create: `src-tauri/src/android.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add settings fields**

Modify `src-tauri/src/settings.rs` `Settings` struct with defaults matching existing serde style:

```rust
#[serde(default = "default_android_manager_host")]
pub android_manager_host: String,
#[serde(default = "default_android_manager_port")]
pub android_manager_port: u16,
#[serde(default)]
pub android_manager_token: String,
```

Add helpers:

```rust
fn default_android_manager_host() -> String { "127.0.0.1".into() }
fn default_android_manager_port() -> u16 { 40327 }
```

- [ ] **Step 2: Add store paths**

Modify `src-tauri/src/store.rs`:

```rust
pub fn android_manager_dir() -> Result<PathBuf> {
    let p = config_root()?.join("android-manager");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn android_manager_config_path() -> Result<PathBuf> {
    Ok(android_manager_dir()?.join("config.json"))
}
```

- [ ] **Step 3: Add bridge module**

Create `src-tauri/src/android.rs`:

```rust
use crate::{settings, store};
use serde_json::Value;

fn base_url(s: &settings::Settings) -> String {
    format!("http://{}:{}", s.android_manager_host, s.android_manager_port)
}

#[tauri::command]
pub async fn android_status() -> Result<Value, String> {
    android_get("/health".into()).await
}

#[tauri::command]
pub async fn android_validate() -> Result<Value, String> {
    android_get("/validate".into()).await
}

#[tauri::command]
pub async fn android_get(path: String) -> Result<Value, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let clean = if path.starts_with('/') { path } else { format!("/{path}") };
    let url = format!("{}{}", base_url(&s), clean);
    let resp = reqwest::Client::new().get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("Android Manager API {status}: {text}")); }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn android_post(path: String, body: Value) -> Result<Value, String> {
    let s = settings::load().map_err(|e| e.to_string())?;
    let clean = if path.starts_with('/') { path } else { format!("/{path}") };
    let url = format!("{}{}", base_url(&s), clean);
    let resp = reqwest::Client::new().post(url).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("Android Manager API {status}: {text}")); }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn android_config_path() -> Result<String, String> {
    store::android_manager_config_path()
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Register module and commands**

Modify `src-tauri/src/lib.rs`:

```rust
mod android;
```

Add commands to `tauri::generate_handler![...]`:

```rust
android::android_status,
android::android_validate,
android::android_get,
android::android_post,
android::android_config_path,
```

- [ ] **Step 5: Build Rust**

```powershell
npm.cmd run tauri build
```

Expected: Rust compiles or fails only on unrelated existing environment packaging issues. If packaging fails after Rust compile, run `cargo check` inside `src-tauri` to isolate Rust errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/store.rs src-tauri/src/settings.rs src-tauri/src/android.rs src-tauri/src/lib.rs
git commit -m "feat: add Android manager Tauri bridge"
```

---

### Task 7: Local HTTP API Routes

**Files:**
- Modify: `src-tauri/src/api.rs`
- Modify: `openapi.yaml`

- [ ] **Step 1: Add API handlers**

In `src-tauri/src/api.rs`, add handlers using `reqwest` to forward to Android Manager:

```rust
async fn android_forward_get(Path(path): Path<String>) -> ApiResult {
    let value = crate::android::android_get(format!("/{path}")).await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(value))
}

async fn android_forward_post(Path(path): Path<String>, Json(body): Json<Value>) -> ApiResult {
    let value = crate::android::android_post(format!("/{path}"), body).await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(value))
}
```

- [ ] **Step 2: Add routes**

In protected router:

```rust
.route("/android/:path", get(android_forward_get).post(android_forward_post))
```

If axum wildcard is preferred after compile check, use `"/android/*path"` and `Path<String>`.

- [ ] **Step 3: Document OpenAPI paths**

Add to `openapi.yaml`:

```yaml
  /android/health:
    get:
      summary: Android manager health
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Android manager health response
  /android/validate:
    get:
      summary: Validate Android host capabilities
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Host validation checks
  /android/instances:
    get:
      summary: List Android instances
      security:
        - bearerAuth: []
      responses:
        "200":
          description: Android instances
    post:
      summary: Create Android instance
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:
                  type: string
                image:
                  type: string
                proxy_id:
                  type: string
      responses:
        "200":
          description: Created Android instance
```

- [ ] **Step 4: Build**

```powershell
npm.cmd run build
```

Expected: TypeScript/Vite build passes. Rust route compile is verified by Tauri build or `cargo check`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/api.rs openapi.yaml
git commit -m "feat: expose Android manager API"
```

---

### Task 8: React Android Tab MVP

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Add TypeScript types**

In `src/App.tsx`, add:

```ts
type AndroidHostCheck = { name: string; ok: boolean; detail: string };
type AndroidValidation = { ok: boolean; checks: AndroidHostCheck[] };
type AndroidInstance = {
  id: string;
  name: string;
  image: string;
  adb_host: string;
  adb_port: number;
  container_name: string;
  volume_name: string;
  status: string;
  proxy_id?: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 2: Add section enum item**

Update existing `Section` union:

```ts
type Section = "browsers" | "android" | "proxies" | "proxypool" | "proxyshard" | "fingerprints" | "settings";
```

Add sidebar entry near `Browsers`:

```tsx
{ id: "android", label: "Android", svg: <IconPhone /> },
```

Use an existing icon pattern or add a small `IconPhone` component matching local icon style.

- [ ] **Step 3: Add Android view component**

Add component in `src/App.tsx`:

```tsx
function AndroidView() {
  const [validation, setValidation] = useState<AndroidValidation | null>(null);
  const [instances, setInstances] = useState<AndroidInstance[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("phone-1");

  const refresh = async () => {
    const [v, list] = await Promise.allSettled([
      invoke<AndroidValidation>("android_validate"),
      invoke<AndroidInstance[]>("android_get", { path: "/instances" }),
    ]);
    if (v.status === "fulfilled") setValidation(v.value);
    if (list.status === "fulfilled") setInstances(list.value);
  };

  useEffect(() => { refresh().catch(() => {}); }, []);

  const createInstance = async () => {
    setBusy(true);
    try {
      await invoke("android_post", { path: "/instances", body: { name } });
      toast.ok("Android instance created");
      await refresh();
    } catch (err) {
      toast.err(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="launcher-panel android-view">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Android Cloud Phone</p>
          <h2>Android instances</h2>
        </div>
        <button className="btn-ghost" onClick={() => refresh()} disabled={busy}>Refresh</button>
      </div>

      <div className="metrics-row">
        <Metric label="Host" value={validation?.ok ? "Ready" : "Needs setup"} accent={validation?.ok} />
        <Metric label="Instances" value={String(instances.length)} />
      </div>

      <div className="form-row android-create-row">
        <Field label="Name" value={name} onChange={setName} />
        <button className="btn-primary" onClick={createInstance} disabled={busy || !name.trim()}>Create</button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Status</th><th>ADB</th><th>Image</th><th>Created</th></tr>
          </thead>
          <tbody>
            {instances.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td><span className="status-pill">{item.status}</span></td>
                <td className="mono">{item.adb_host}:{item.adb_port}</td>
                <td className="mono">{item.image}</td>
                <td>{new Date(item.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Render section**

Add main switch branch:

```tsx
{section === "android" && <AndroidView />}
```

- [ ] **Step 5: Add minimal CSS**

Add to `src/App.css`:

```css
.android-view .android-create-row {
  align-items: end;
  grid-template-columns: minmax(180px, 320px) auto;
}

.android-view .status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--surface-muted);
  color: var(--text);
  font-size: 12px;
}
```

- [ ] **Step 6: Build frontend**

```powershell
npm.cmd run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.css
git commit -m "feat: add Android instances tab"
```

---

### Task 9: Real Lifecycle Actions

**Files:**
- Modify: `android_manager/android_manager/storage.py`
- Modify: `android_manager/android_manager/api.py`
- Modify: `android_manager/android_manager/docker_service.py`
- Modify: `android_manager/android_manager/adb_service.py`
- Create: `android_manager/android_manager/scrcpy_service.py`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add storage lookup/update/delete methods**

Add methods to `AndroidStore`: `get_instance(id)`, `set_status(id, status)`, `delete_instance(id)`.

Expected behavior:

```text
get unknown id -> raises KeyError
set_status updates updated_at
delete removes row
```

- [ ] **Step 2: Add manager endpoints**

Add routes:

```text
POST /instances/{id}/start
POST /instances/{id}/stop
DELETE /instances/{id}
POST /instances/{id}/install-apk
POST /instances/{id}/set-proxy
POST /instances/{id}/clear-proxy
GET /instances/{id}/screenshot
POST /instances/{id}/open-screen
```

Use fixed service methods only. Do not accept raw shell commands from requests.

- [ ] **Step 3: Add scrcpy wrapper**

Create `android_manager/android_manager/scrcpy_service.py`:

```python
from __future__ import annotations

import subprocess


class ScrcpyService:
    def open_screen(self, adb_host: str, adb_port: int) -> None:
        subprocess.Popen(["scrcpy", "-s", f"{adb_host}:{adb_port}", "--no-audio"])
```

- [ ] **Step 4: Add UI row actions**

In `AndroidView`, add buttons per row:

```tsx
<button className="btn-ghost btn-sm" onClick={() => invoke("android_post", { path: `/instances/${item.id}/start`, body: {} }).then(refresh)}>Start</button>
<button className="btn-ghost btn-sm" onClick={() => invoke("android_post", { path: `/instances/${item.id}/stop`, body: {} }).then(refresh)}>Stop</button>
<button className="btn-ghost btn-sm" onClick={() => invoke("android_post", { path: `/instances/${item.id}/open-screen`, body: {} })}>Screen</button>
```

- [ ] **Step 5: Test fake API and build**

```bash
cd android_manager
python -m pytest -v
```

```powershell
npm.cmd run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android_manager/android_manager src/App.tsx
git commit -m "feat: add Android lifecycle actions"
```

---

### Task 10: End-To-End MVP Verification

**Files:**
- Modify: `android_manager/README.md`
- Modify: `phonegrid-like-android-platform-plan.md`

- [ ] **Step 1: Verify Windows dev path**

Run manager locally without real ReDroid actions:

```powershell
cd android_manager
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .[dev]
.\.venv\Scripts\python.exe -m android_manager serve
```

Run app build:

```powershell
npm.cmd run build
```

Expected: UI builds; `/health`, `/validate`, `/instances` reachable when manager runs.

- [ ] **Step 2: Verify Linux ReDroid path**

On Ubuntu host:

```bash
bash scripts/android-host-validator.sh
cd android_manager
python3 -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
python -m android_manager serve
```

From launcher machine:

```bash
curl http://HOST:40327/health
curl http://HOST:40327/validate
```

Expected: health OK; validate required checks OK.

- [ ] **Step 3: Update docs with known limits**

Append to `android_manager/README.md`:

```markdown
## MVP Limits

- ReDroid requires Linux binder devices; Windows-native runtime is not part of MVP.
- Android global HTTP proxy is best effort and does not force all app traffic.
- `scrcpy` opens a native window; browser-embedded streaming is a later phase.
- APK compatibility must be validated with target apps, especially ARM-only or Google Play Services apps.
- ADB ports must stay bound to localhost/private networks.
```

- [ ] **Step 4: Update original plan note**

Add a short note near top of `phonegrid-like-android-platform-plan.md`:

```markdown
## Repo Integration Decision

For BrProxies, Android runtime is implemented as an external Linux-hosted Android Manager sidecar/API. The Windows Tauri app can develop and control it, but ReDroid containers themselves require Linux host support for binder devices.
```

- [ ] **Step 5: Final verification commands**

```bash
cd android_manager
python -m pytest -v
```

```powershell
npm.cmd run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android_manager/README.md phonegrid-like-android-platform-plan.md
git commit -m "docs: document Android MVP limits"
```

---

## Review Notes

- This plan deliberately avoids requiring ReDroid to run on Windows. Windows remains viable for launcher/UI/API development.
- Task 1 is the hard gate. If validator fails on target Linux host, pause implementation and fix host/kernel before building more UI.
- Proxy MVP is intentionally basic. Full traffic proxying needs a separate plan using VPN app, per-instance network namespace, or host tproxy.
- Embedded live screen streaming needs a separate plan using scrcpy video bridge/WebRTC/noVNC-style transport.
- Android anti-detect fingerprinting needs a separate research/spec phase after baseline instance lifecycle works.

## Self-Review

- Spec coverage: MVP create/start/stop/delete, ADB port allocation, APK install, screenshot, scrcpy, proxy basics, dashboard, and API are mapped to Tasks 1-10.
- Placeholder scan: no `TBD`, `TODO`, or open-ended implementation steps remain.
- Type consistency: `AndroidInstance`, `AndroidInstanceCreate`, `/instances`, `android_get`, and `android_post` names match across sidecar, Tauri bridge, and React UI.
- Scope check: production streaming, full proxy capture, Android anti-detect, billing, and RBAC are intentionally excluded and called out as later plans.
