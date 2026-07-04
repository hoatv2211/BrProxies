# BrProxies ProxyPool Chrome Extension

Manifest V3 extension for using a local BrProxies ProxyPool proxy in Chrome.
It talks to the ProxyPool sidecar at `http://127.0.0.1:40326` and applies a
selected proxy through the Chrome `chrome.proxy` API.

## Load locally

1. Run `smart launch\run.bat` from the repo root. This starts Redis, cleans
   stale ProxyPool sidecars, and opens BrProxies.
2. Open BrProxies > ProxyPool.
3. Click `Connect`, then collect/check proxies until working rows exist.
4. Open Chrome `chrome://extensions`.
5. Enable `Developer mode`.
6. Click `Load unpacked` and choose this `extension` folder.

## Use

1. Open the `BrProxies ProxyPool` extension popup.
2. Keep `Pool API URL` as `http://127.0.0.1:40326` for local use.
3. Click `Connect`.
4. Click `Test live` to run the same live check path as ProxyPool `Test all`.
5. Click `Use` on a live proxy, or click `Rotate` to pick a random live proxy.
6. Click `Direct` to clear the proxy and return Chrome to direct networking.

## Limits

- Local v1 only allows `http://127.0.0.1:40326/*` and `http://localhost:40326/*`.
- Remote VPS URL support needs a later permission/auth update.
- Username/password proxy auth is not implemented yet.
- The extension does not run Redis or ProxyPool; BrProxies local service must be running.
- `Connect` only reads the pool; `Test live` rechecks stored proxies and hides rows with `fail_count > 0`.
- The extension controls Chrome proxy settings only. It does not control
  BrProxies browser profiles or Android Manager devices.
