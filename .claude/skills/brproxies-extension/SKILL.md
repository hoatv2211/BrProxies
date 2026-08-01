---
name: brproxies-extension
description: Persona cho Chrome ProxyPool extension của BrProxies (extension/). Use khi làm việc với MV3 extension — background.js service worker, popup, chrome.proxy settings, kết nối proxypool sidecar 40326, npm run test:extension, validate-extension.mjs, hoặc nhắc "extension", "chrome proxy", "proxypool extension", "manifest".
---

# BrProxies ProxyPool Extension — Persona

Bạn phụ trách `extension/` — Chrome **Manifest V3** extension áp proxy từ ProxyPool sidecar vào Chrome qua `chrome.proxy`.

Authoritative: `extension/README.md` + `extension/manifest.json`.

## 1. Cấu trúc

- `manifest.json` — MV3, name `BrProxies ProxyPool` v0.1.0. Permissions: `proxy`, `storage`. **host_permissions HẸP**: chỉ `http://127.0.0.1:40326/*` + `http://localhost:40326/*`.
- `background.js` — service worker. `DEFAULT_API_URL = http://127.0.0.1:40326`.
- `popup.html` / `popup.css` / `popup.js` — UI.

## 2. Hành vi (background.js)

Message handlers (`handleMessage`):
- `connect` — load pool: `/health` + `/proxies?https=false`, lọc row live (`fail_count===0` → `liveProxies`).
- `testLive` — `POST /jobs/check`, poll `/health` tới khi job hết `running` (`waitForJob`).
- `setProxy`/`rotateProxy` — `chrome.proxy.settings` fixed_servers, scheme `http`, bypass `<local>` (`setChromeProxy`).
- `clearProxy` — `Direct`. `getState`.

Chỉ nói chuyện với sidecar `40326`. Không auth proxy user/pass. Không tự chạy Redis/ProxyPool. Contract phụ thuộc proxypool_service — xem `brproxies-python-services`.

## 3. Validate — npm run test:extension

```bash
npm run test:extension    # node extension/tests/validate-extension.mjs
```

Validator TĨNH (không mở browser), lint manifest + file. Kiểm tra:
- `manifest.json` parse được, `manifest_version === 3`.
- permissions gồm `proxy` + `storage`.
- host_permissions gồm ĐÚNG 2 narrow: `http://127.0.0.1:40326/*`, `http://localhost:40326/*`.
- **REJECT broad host**: fail nếu có `http://*/*`, `https://*/*`, hoặc `<all_urls>`.
- `background.service_worker === "background.js"`, `action.default_popup === "popup.html"`.
- Tồn tại đủ file: `background.js`, `popup.html`, `popup.css`, `popup.js`, `README.md`.
- Fail → `process.exitCode = 1`. Không ghi file.

## 4. Rules (MANDATORY)

- **KHÔNG mở rộng host_permissions ra broad** (`*://*/*`, `<all_urls>`) — validator sẽ fail và là chủ ý bảo mật. Chỉ localhost `40326`.
- Thêm file mới vào extension → cập nhật danh sách required trong `validate-extension.mjs` nếu nó bắt buộc.
- Giữ MV3 (service worker, không background page).
- Đổi endpoint proxypool → sync với `brproxies-python-services` (proxypool_service `40326`).
- Chạy `npm run test:extension` sau mọi sửa manifest.
