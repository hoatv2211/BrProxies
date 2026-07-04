from pathlib import Path

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

def test_validate_endpoint_uses_windows_avd_runtime(tmp_path, monkeypatch):
    monkeypatch.delenv("ANDROID_MANAGER_RUNTIME", raising=False)
    config_path = tmp_path / "android-manager.json"
    config_path.write_text('{"runtime":"windows_avd","data_dir":"' + str(tmp_path).replace('\\', '\\\\') + '"}', encoding="utf-8")
    client = TestClient(create_app(str(config_path)))

    resp = client.get("/validate")

    assert resp.status_code == 200
    body = resp.json()
    assert body["runtime"] == "windows_avd"
    assert {item["name"] for item in body["checks"]} >= {"adb", "emulator", "avdmanager", "scrcpy"}
    assert "binder" not in {item["name"] for item in body["checks"]}


def test_create_lifecycle_and_screenshot(tmp_path, monkeypatch):
    monkeypatch.setenv("ANDROID_MANAGER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ANDROID_MANAGER_FAKE_RUNTIME", "1")
    client = TestClient(create_app())

    resp = client.post("/instances", json={"name": "phone-1"})
    assert resp.status_code == 200
    created = resp.json()
    assert created["name"] == "phone-1"
    assert created["adb_port"] == 5555
    assert created["status"] == "running"

    assert client.post(f"/instances/{created['id']}/stop").json()["status"] == "stopped"
    assert client.post(f"/instances/{created['id']}/start").json()["status"] == "running"
    assert client.post(f"/instances/{created['id']}/set-proxy", json={"host": "127.0.0.1", "port": 8080}).json()["proxy_id"] == "127.0.0.1:8080"
    assert client.post(f"/instances/{created['id']}/clear-proxy").json()["proxy_id"] is None

    apk = Path(tmp_path) / "app.apk"
    apk.write_bytes(b"fake")
    assert client.post(f"/instances/{created['id']}/install-apk", json={"apk_path": str(apk)}).json()["ok"] is True
    assert client.get(f"/instances/{created['id']}/screenshot").headers["content-type"] == "image/png"
    opened = client.post(f"/instances/{created['id']}/open-screen").json()
    assert opened["ok"] is True
    assert opened["opened"] is False
    assert "fake runtime" in opened["message"]
    assert client.delete(f"/instances/{created['id']}").json()["ok"] is True
    assert client.get("/instances").json() == []

def test_create_uses_config_path_fake_runtime(tmp_path, monkeypatch):
    monkeypatch.delenv("ANDROID_MANAGER_FAKE_RUNTIME", raising=False)
    monkeypatch.delenv("ANDROID_MANAGER_DATA_DIR", raising=False)
    config_path = tmp_path / "android-manager.json"
    config_path.write_text(
        '{"data_dir":"' + str(tmp_path).replace('\\', '\\\\') + '","fake_runtime":true}',
        encoding="utf-8",
    )
    client = TestClient(create_app(str(config_path)), raise_server_exceptions=False)

    resp = client.post("/instances", json={"name": "phone-config"})

    assert resp.status_code == 200
    assert resp.json()["status"] == "running"

def test_windows_avd_runtime_lifecycle_uses_avd_service(tmp_path, monkeypatch):
    calls = []

    class FakeAvdService:
        def __init__(self, data_dir, system_image="", device=""):
            calls.append(("init", data_dir, system_image, device))
        def create(self, name):
            calls.append(("create", name))
        def exists(self, name):
            return True
        def start(self, name, port):
            calls.append(("start", name, port))
        def open_screen(self, port):
            calls.append(("screen", port))
        def stop(self, port):
            calls.append(("stop", port))
        def delete(self, name):
            calls.append(("delete", name))

    monkeypatch.setattr("android_manager.api.AvdService", FakeAvdService)
    monkeypatch.setattr("android_manager.api.AdbService", lambda fake=False: None)
    config_path = tmp_path / "android-manager.json"
    config_path.write_text(
        '{"runtime":"windows_avd","data_dir":"' + str(tmp_path).replace('\\', '\\\\') + '","adb_port_start":5555,"adb_port_end":5559}',
        encoding="utf-8",
    )
    client = TestClient(create_app(str(config_path)))

    created = client.post("/instances", json={"name": "phone-avd"}).json()
    assert created["status"] == "running"
    assert created["adb_port"] == 5556
    assert client.post(f"/instances/{created['id']}/open-screen").json()["opened"] is True
    assert client.post(f"/instances/{created['id']}/stop").json()["status"] == "stopped"
    assert client.delete(f"/instances/{created['id']}").json()["ok"] is True

    avd_name = "brproxies_android_phone_avd_5556"
    assert ("create", avd_name) in calls
    assert ("start", avd_name, 5556) in calls
    assert ("screen", 5556) in calls
    assert ("stop", 5556) in calls
    assert ("delete", avd_name) in calls

def test_windows_avd_list_adopts_running_emulator(tmp_path, monkeypatch):
    class Running:
        name = "brproxies_android_phone_1_5558"
        console_port = 5558
        serial = "emulator-5558"

    class FakeAvdService:
        def __init__(self, data_dir, system_image="", device=""):
            pass
        def running_avds(self):
            return [Running()]

    monkeypatch.setattr("android_manager.api.AvdService", FakeAvdService)
    config_path = tmp_path / "android-manager.json"
    config_path.write_text(
        '{"runtime":"windows_avd","data_dir":"' + str(tmp_path).replace('\\', '\\\\') + '","avd_system_image":"system-images;android-35;google_apis_playstore;x86_64"}',
        encoding="utf-8",
    )
    client = TestClient(create_app(str(config_path)))

    resp = client.get("/instances")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["container_name"] == "brproxies_android_phone_1_5558"
    assert body[0]["adb_port"] == 5558
    assert body[0]["status"] == "running"

def test_windows_avd_start_creates_legacy_instance_avd_when_missing(tmp_path, monkeypatch):
    calls = []

    class FakeAvdService:
        def __init__(self, data_dir, system_image="", device=""):
            pass
        def create(self, name):
            calls.append(("create", name))
        def exists(self, name):
            calls.append(("exists", name))
            return False
        def start(self, name, port):
            calls.append(("start", name, port))

    monkeypatch.setattr("android_manager.api.AvdService", FakeAvdService)
    config_path = tmp_path / "android-manager.json"
    config_path.write_text(
        '{"runtime":"windows_avd","data_dir":"' + str(tmp_path).replace('\\', '\\\\') + '","fake_runtime":true}',
        encoding="utf-8",
    )
    client = TestClient(create_app(str(config_path)))
    created = client.post("/instances", json={"name": "legacy phone"}).json()
    store_path = tmp_path / "android-manager.json"
    store_path.write_text(
        '{"runtime":"windows_avd","data_dir":"' + str(tmp_path).replace('\\', '\\\\') + '"}',
        encoding="utf-8",
    )

    resp = client.post(f"/instances/{created['id']}/start")

    assert resp.status_code == 200
    assert resp.json()["adb_port"] == 5556
    assert calls == [
        ("exists", created["container_name"]),
        ("create", created["container_name"]),
        ("start", created["container_name"], 5556),
    ]

def test_windows_avd_create_runtime_error_returns_400(tmp_path, monkeypatch):
    class FakeAvdService:
        def __init__(self, data_dir, system_image="", device=""):
            pass
        def create(self, name):
            raise RuntimeError("No Android x86_64 system image is installed")

    monkeypatch.setattr("android_manager.api.AvdService", FakeAvdService)
    config_path = tmp_path / "android-manager.json"
    config_path.write_text(
        '{"runtime":"windows_avd","data_dir":"' + str(tmp_path).replace('\\', '\\\\') + '","adb_port_start":5555,"adb_port_end":5559}',
        encoding="utf-8",
    )
    client = TestClient(create_app(str(config_path)), raise_server_exceptions=False)

    resp = client.post("/instances", json={"name": "phone-avd"})

    assert resp.status_code == 400
    assert "No Android x86_64 system image" in resp.json()["detail"]
