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
    assert client.post(f"/instances/{created['id']}/open-screen").json()["ok"] is True
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
