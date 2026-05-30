# ShardX MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI client
(Claude Desktop, Cursor, …) drive the **ShardX Launcher**:

- the local automation **HTTP API** — create/edit/launch/close profiles,
  manage proxies, fingerprints, folders and cookies;
- a launched profile's **browser over CDP**, driven with
  [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)
  (a stealth-patched Playwright) so the automation stays undetected.

Requires **Node ≥ 18**. The app itself does **not** run this server — it
only downloads the source for you (**Settings → MCP server → Download MCP
server**, pick a folder). You then install deps and register it with your
MCP client.

### 1. Install deps

`connectOverCDP` only *connects* to the already-running ShardX browser, so
patchright's own Chromium is never needed — install with the browser
download skipped to keep `node_modules` small:

```bash
cd <downloaded>/mcp
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

### 2. Register with your MCP client (stdio)

```json
{
  "mcpServers": {
    "shardx": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/mcp/index.js"],
      "env": {
        "SHARDX_API": "http://127.0.0.1:40325",
        "SHARDX_TOKEN": "<Bearer token from Settings → Automation API>"
      }
    }
  }
}
```

### HTTP mode (optional, self-hosted)

If you'd rather host it yourself and connect by URL, run it with
`MCP_HTTP_PORT` set — it then serves at `http://127.0.0.1:<port>/mcp`:

```bash
MCP_HTTP_PORT=40326 SHARDX_API=http://127.0.0.1:40325 SHARDX_TOKEN=… node index.js
```

## Environment

| Var             | Default                  | Notes                                               |
| --------------- | ------------------------ | --------------------------------------------------- |
| `SHARDX_API`    | `http://127.0.0.1:40325` | Launcher API base URL.                              |
| `SHARDX_TOKEN`  | —                        | Bearer token (Settings). Required.                  |
| `MCP_HTTP_PORT` | — (stdio)                | When set, serve HTTP at `127.0.0.1:<port>/mcp`.     |

## Tools

**API**

- `list_profiles`, `get_profile`, `create_profile`, `create_temporary_profile`,
  `edit_profile`, `delete_profile`
- `new_fingerprint(platform?)`
- `start_profile(id, headless?)` → returns the CDP endpoint,
  `stop_profile(id)`, `list_running`
- `list_proxies`, `add_proxy`, `delete_proxy`
- `list_fingerprints`, `list_folders`, `rename_folder`, `delete_folder`
- `export_cookies`, `import_cookies`

**Browser (CDP via patchright)** — auto-starts the profile (CDP, optional
headless) if it isn't running; actions target the profile's *active* tab:

- Navigation: `browser_navigate(url, headless?)`, `browser_back`,
  `browser_forward`, `browser_reload`, `browser_current_url`
- Waiting: `browser_wait_for_selector(selector, state?, timeout_ms?)`,
  `browser_wait_for_load(state?)`, `browser_wait(ms)`,
  `browser_wait_for_url(url, timeout_ms?)`, `browser_wait_for_function(expression, timeout_ms?)`
- Read: `browser_content`, `browser_text`, `browser_get_html(selector?)`,
  `browser_get_text(selector)`, `browser_get_attribute(selector, name)`,
  `browser_exists(selector)`, `browser_count(selector)`,
  `browser_element_state(selector)`, `browser_bounding_box(selector)`,
  `browser_links`, `browser_evaluate(expression)`, `browser_get_cookies`
- Interact: `browser_click(selector)`, `browser_double_click(selector)`,
  `browser_right_click(selector)`, `browser_fill(selector, text)`,
  `browser_type(selector, text, delay_ms?)`, `browser_press(key)`,
  `browser_hover(selector)`, `browser_select_option(selector, value, by?)`,
  `browser_set_checkbox(selector, checked)`, `browser_focus(selector)`,
  `browser_drag(from, to)`, `browser_mouse_click(x, y)`,
  `browser_scroll(selector? | dx/dy)`, `browser_scroll_to_bottom`,
  `browser_set_files(selector, paths)`
- Capture: `browser_screenshot(full_page?)`,
  `browser_element_screenshot(selector)`, `browser_pdf` (headless),
  `browser_set_viewport(width, height)`
- Storage / network: `browser_set_cookies(cookies)`, `browser_clear_cookies`,
  `browser_local_storage(action, key?, value?)`,
  `browser_set_extra_headers(headers)`, `browser_dialog(action, prompt_text?)`,
  `browser_block_resources(types)`
- Tabs: `browser_list_tabs`, `browser_open_tab(url?)`,
  `browser_switch_tab(index)`, `browser_close_tab(index?)`
- Frames: `browser_frames`, `browser_frame_evaluate(frame, expression)`
- Scrape / a11y: `browser_get_texts(selector)`, `browser_input_value(selector)`,
  `browser_insert_text(text)`, `browser_aria_snapshot(selector?)`
- Network: `browser_wait_for_response(url_pattern, timeout_ms?)`,
  `browser_capture_start` / `browser_capture_stop` (request log),
  `browser_mock(url_pattern, status?, body?, content_type?)` / `browser_unmock(url_pattern?)`,
  `browser_intercept(url_pattern, headers?, post_data?, abort?)` (modify in flight),
  `browser_set_network_conditions(offline?, latency_ms?, download_kbps?, upload_kbps?)`
- Keyboard: `browser_press_on(selector, key)`
- Downloads: `browser_wait_for_download(dir, timeout_ms?)`

(All take `profile_id` as the first argument.)

## Typical agent flow

1. `create_profile` (or `create_temporary_profile`) — optionally with a `proxy`.
2. `browser_navigate(profile_id, "https://…")` — starts the browser with
   CDP and opens the page.
3. `browser_evaluate` / `browser_screenshot` / `browser_click` / `browser_fill`.
4. `stop_profile` when done (temporary profiles self-delete on close).
