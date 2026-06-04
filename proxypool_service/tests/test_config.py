from proxypool_service.config import ProxyPoolConfig, load_config


def test_default_config_values():
    cfg = ProxyPoolConfig()
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 40326
    assert cfg.redis_url == "redis://127.0.0.1:6379/0"
    assert cfg.collect_interval_seconds == 900
    assert cfg.check_interval_seconds == 300
    assert cfg.timeout_seconds == 8.0
    assert cfg.max_concurrency == 50
    assert cfg.failure_threshold == 2
    assert cfg.disabled_sources == set()
    assert cfg.initial_collect is True


def test_load_config_from_json_and_env(tmp_path, monkeypatch):
    path = tmp_path / "proxypool.json"
    path.write_text(
        '{"host":"127.0.0.2","port":41000,"redis_url":"redis://redis:6379/1",'
        '"disabled_sources":["us_proxy"],"initial_collect":false}',
        encoding="utf-8",
    )
    monkeypatch.setenv("PROXYPOOL_PORT", "42000")
    monkeypatch.setenv("PROXYPOOL_DISABLED_SOURCES", "ssl_proxies,geonode_free")
    cfg = load_config(str(path))
    assert cfg.host == "127.0.0.2"
    assert cfg.port == 42000
    assert cfg.redis_url == "redis://redis:6379/1"
    assert cfg.disabled_sources == {"ssl_proxies", "geonode_free"}
    assert cfg.initial_collect is False

