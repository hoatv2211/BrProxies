# Chrome ProxyPool Extension Design

## Goal

Build a Manifest V3 Chrome extension that connects to the local BrProxies ProxyPool service and applies one working proxy to Chrome. The first version targets local use with `http://127.0.0.1:40326`; remote VPS URLs can be added later behind a narrower security review.

## Scope

- Create an unpacked Chrome extension under `extension/`.
- Read working proxies from the local ProxyPool API.
- Let the user connect, inspect count/status, choose a proxy, rotate to another proxy, or return Chrome to direct mode.
- Store the Pool API URL and last selected proxy in Chrome extension storage.
- Keep permissions minimal for Chrome Web Store review.

Out of scope for this version:

- Bundling Redis, Python, or ProxyPool inside the extension.
- Remote VPS auth/token support.
- Username/password proxy auth handling.
- Publishing package automation for Chrome Web Store.

## User Flow

1. User runs `smart launch\run.bat` so Redis, BrProxies, and ProxyPool are available locally.
2. User opens ProxyPool in BrProxies, connects, collects/checks proxies, and gets working rows.
3. User loads `extension/` as an unpacked extension in Chrome.
4. User opens the extension popup and clicks `Connect`.
5. Popup calls `GET /health` and `GET /proxies?https=false` on `http://127.0.0.1:40326`.
6. User clicks `Use` on a proxy or `Rotate` to pick another one.
7. Extension service worker calls `chrome.proxy.settings.set` with `fixed_servers`.
8. User clicks `Direct` to clear the extension proxy and return to direct networking.

## Architecture

- `extension/manifest.json` defines MV3 metadata, popup, service worker, `proxy` and `storage` permissions, and local host permissions.
- `extension/background.js` owns all calls to `chrome.proxy`; popup never touches proxy APIs directly.
- `extension/popup.html`, `extension/popup.css`, and `extension/popup.js` provide a small UI for local Pool API status and proxy selection.
- `extension/README.md` documents loading, usage, and current limitations.

The popup talks to the service worker via `chrome.runtime.sendMessage`. The service worker performs fetches to ProxyPool and proxy setting changes. This keeps privileged browser operations in one place and makes future token/auth support easier.

## Data Flow

- `connect` message:
  - input: `{ apiUrl }`
  - service worker fetches `/health` and `/proxies?https=false`
  - output: `{ health, proxies }`
- `setProxy` message:
  - input: `{ proxy }`, where proxy is an object from ProxyPool with at least `proxy`, `host`, and `port` fields when available
  - service worker normalizes the host/port and sets `chrome.proxy.settings`
  - output: `{ activeProxy }`
- `rotateProxy` message:
  - input: `{ apiUrl }`
  - service worker fetches `/proxy/random?https=false` and applies it
  - output: `{ activeProxy }`
- `clearProxy` message:
  - clears Chrome proxy settings for this extension scope
  - output: `{ activeProxy: null }`

## Error Handling

- Invalid Pool API URL shows a popup error without changing proxy settings.
- ProxyPool offline shows a connect error and keeps current proxy state unchanged.
- Empty pool shows `No proxies available`; `Rotate` is disabled by error state.
- Invalid proxy records are ignored when rendering the list and rejected before applying.
- Chrome proxy API errors are surfaced from `chrome.runtime.lastError` in the popup.

## Security

- Host permissions are limited to `http://127.0.0.1:40326/*` and `http://localhost:40326/*`.
- No broad `http://*/*` or `https://*/*` permissions in v1.
- No credentials stored beyond local API URL and last selected proxy.
- Remote VPS support must add token/auth and permission handling in a separate change.

## Testing

- Static validation verifies `manifest.json` exists, MV3 is used, required permissions are present, and broad host permissions are absent.
- Manual test path:
  - run BrProxies local
  - collect/check ProxyPool
  - load `extension/`
  - connect to local Pool API
  - set a proxy
  - clear back to direct

