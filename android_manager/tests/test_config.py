from android_manager.config import AndroidManagerConfig, load_config


def test_default_config_values():
    cfg = AndroidManagerConfig()
    assert cfg.runtime == "redroid"
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 40327
    assert cfg.redroid_image == "redroid/redroid:12.0.0-latest"
    assert cfg.avd_device == "pixel_2"
    assert cfg.adb_port_start == 5555
    assert cfg.adb_port_end == 5999
    assert cfg.container_prefix == "brproxies-android-"
    assert cfg.volume_prefix == "brproxies_android_"


def test_load_config_from_json_and_env(tmp_path, monkeypatch):
    path = tmp_path / "android-manager.json"
    path.write_text(
        '{"runtime":"windows_avd","host":"127.0.0.2","port":41027,"adb_port_start":5600,"adb_port_end":5602}',
        encoding="utf-8",
    )
    monkeypatch.setenv("ANDROID_MANAGER_RUNTIME", "fake")
    monkeypatch.setenv("ANDROID_MANAGER_PORT", "42027")
    monkeypatch.setenv("ANDROID_MANAGER_REDROID_IMAGE", "redroid/redroid:13.0.0-latest")
    cfg = load_config(str(path))
    assert cfg.runtime == "fake"
    assert cfg.host == "127.0.0.2"
    assert cfg.port == 42027
    assert cfg.redroid_image == "redroid/redroid:13.0.0-latest"
    assert cfg.adb_port_start == 5600
    assert cfg.adb_port_end == 5602
