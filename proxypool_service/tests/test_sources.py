from proxypool_service.config import ProxyPoolConfig
from proxypool_service.sources import (
    BUILTIN_SOURCES,
    enabled_sources,
    parse_geonode_json,
    parse_plain_text,
    parse_table,
)


TABLE_HTML = """
<table><tbody>
  <tr><td>1.2.3.4</td><td>8080</td><td>US</td></tr>
  <tr><td>bad</td><td>port</td></tr>
  <tr><td>5.6.7.8</td><td>3128</td></tr>
</tbody></table>
"""


def test_builtin_source_ids_are_stable():
    assert set(BUILTIN_SOURCES) == {
        "free_proxy_list",
        "ssl_proxies",
        "us_proxy",
        "proxy_scrape",
        "geonode_free",
    }


def test_enabled_sources_excludes_disabled_ids():
    cfg = ProxyPoolConfig(disabled_sources={"us_proxy", "ssl_proxies"})
    assert [source.id for source in enabled_sources(cfg)] == [
        "free_proxy_list",
        "proxy_scrape",
        "geonode_free",
    ]


def test_parse_table_extracts_host_port_rows():
    candidates = parse_table(TABLE_HTML, "free_proxy_list")
    assert [candidate.proxy for candidate in candidates] == ["1.2.3.4:8080", "5.6.7.8:3128"]


def test_parse_plain_text_extracts_proxy_lines():
    candidates = parse_plain_text("1.1.1.1:80\nhttp://2.2.2.2:8080\ninvalid", "proxy_scrape")
    assert [candidate.proxy for candidate in candidates] == ["1.1.1.1:80", "2.2.2.2:8080"]


def test_parse_geonode_json_extracts_data_rows():
    body = '{"data":[{"ip":"9.9.9.9","port":"8000"},{"ip":"bad","port":"x"}]}'
    candidates = parse_geonode_json(body, "geonode_free")
    assert [candidate.proxy for candidate in candidates] == ["9.9.9.9:8000"]

