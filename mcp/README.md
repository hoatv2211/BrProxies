# BrProxies MCP Server

MCP server for letting AI clients control BrProxies browser profiles through:

- the local BrProxies Automation API on `http://127.0.0.1:40325`;
- CDP connections to launched browser profiles through patchright.

This MCP server controls browser profiles, proxies, fingerprints, folders,
cookies, and browser tabs. It does not control Android Manager devices.

Requires Node 18 or newer. The desktop app can download this package from
Settings, but you still install dependencies and register it in your MCP client.

## Install

`connectOverCDP` connects to the browser already launched by BrProxies, so the
patchright browser download is not needed:

```bash
cd <downloaded>/mcp
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

On Windows PowerShell:

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1'
$env:PATCHRIGHT_SKIP_BROWSER_DOWNLOAD='1'
npm.cmd install
```

## Register With MCP Client

```json
{
  "mcpServers": {
    "brproxies": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/mcp/index.js"],
      "env": {
        "BRPROXIES_API": "http://127.0.0.1:40325",
        "BRPROXIES_TOKEN": "<Bearer token from BrProxies Settings>"
      }
    }
  }
}
```

## HTTP Mode

Set `MCP_HTTP_PORT` to serve HTTP at `http://127.0.0.1:<port>/mcp`:

```bash
MCP_HTTP_PORT=40327 BRPROXIES_API=http://127.0.0.1:40325 BRPROXIES_TOKEN=<token> node index.js
```

Use a different port from ProxyPool (`40326`) and Android Manager when both are
running.

## Environment

| Var | Default | Notes |
| --- | ------- | ----- |
| `BRPROXIES_API` | `http://127.0.0.1:40325` | Launcher Automation API base URL. |
| `BRPROXIES_TOKEN` | none | Bearer token from Settings. Required. |
| `MCP_HTTP_PORT` | none | When set, serve HTTP instead of stdio. |

Legacy `SHARDX_API` and `SHARDX_TOKEN` still work as aliases.

## Tools

API tools:

- `list_profiles`, `get_profile`, `create_profile`, `create_temporary_profile`
- `edit_profile`, `delete_profile`
- `new_fingerprint(platform?)`
- `start_profile(id, headless?)`, `stop_profile(id)`, `list_running`
- `list_proxies`, `add_proxy`, `delete_proxy`
- `list_fingerprints`, `list_folders`, `rename_folder`, `delete_folder`
- `export_cookies`, `import_cookies`

Browser tools use CDP via patchright and target the active tab of a profile:

- Navigation: `browser_navigate`, `browser_back`, `browser_forward`,
  `browser_reload`, `browser_current_url`
- Waiting: `browser_wait_for_selector`, `browser_wait_for_load`,
  `browser_wait`, `browser_wait_for_url`, `browser_wait_for_function`
- Read: `browser_content`, `browser_text`, `browser_get_html`,
  `browser_get_text`, `browser_get_attribute`, `browser_exists`,
  `browser_count`, `browser_element_state`, `browser_bounding_box`,
  `browser_links`, `browser_evaluate`, `browser_get_cookies`
- Interact: `browser_click`, `browser_double_click`, `browser_right_click`,
  `browser_fill`, `browser_type`, `browser_press`, `browser_hover`,
  `browser_select_option`, `browser_set_checkbox`, `browser_focus`,
  `browser_drag`, `browser_mouse_click`, `browser_scroll`,
  `browser_scroll_to_bottom`, `browser_set_files`
- Capture: `browser_screenshot`, `browser_element_screenshot`, `browser_pdf`,
  `browser_set_viewport`
- Storage/network: `browser_set_cookies`, `browser_clear_cookies`,
  `browser_local_storage`, `browser_set_extra_headers`, `browser_dialog`,
  `browser_block_resources`, `browser_wait_for_response`,
  `browser_capture_start`, `browser_capture_stop`, `browser_mock`,
  `browser_unmock`, `browser_intercept`, `browser_set_network_conditions`
- Tabs/frames: `browser_list_tabs`, `browser_open_tab`, `browser_switch_tab`,
  `browser_close_tab`, `browser_frames`, `browser_frame_evaluate`
- Scrape/a11y/downloads: `browser_get_texts`, `browser_input_value`,
  `browser_insert_text`, `browser_aria_snapshot`, `browser_wait_for_download`

All browser tools take `profile_id` as the first argument.

## Typical Agent Flow

1. Create or choose a profile.
2. Use `browser_navigate(profile_id, url)` to auto-start it with CDP.
3. Use evaluate, screenshot, click, fill, or scrape tools.
4. Stop the profile when finished.
