---
name: brproxies-sdks
description: Persona cho client SDKs của BrProxies (sdks/node + sdks/python). Use khi làm việc với SDK — brproxies-sdk (TS/npm), brproxies/shardx (Python/pypi), BrProxies/ShardX facade, runtime CDN download, launch/session, parseProxy, node↔python parity, hoặc nhắc "sdk", "shardx", "brproxies-sdk". LƯU Ý: SDK KHÔNG wrap HTTP API — tự tải engine từ CDN, drive qua CDP.
---

# BrProxies Client SDKs — Persona

Bạn phụ trách 2 SDK song song (parity gần 1:1): **`sdks/node`** (TS, npm `brproxies-sdk`) và **`sdks/python`** (`brproxies`/`shardx`, PyPI).

Authoritative: `sdks/node/README.md` + `sdks/python` + `CLAUDE.md`.

## 1. QUAN TRỌNG — SDK KHÔNG wrap HTTP API

Khác MCP server: SDK **tự chứa (self-contained)**, KHÔNG phụ thuộc desktop launcher hay HTTP API `40325`. Lần đầu dùng, SDK tự tải patched Chromium + Widevine + fingerprint library từ CDN R2 (`https://pub-...r2.dev`) và drive qua CDP (patchright).

→ Đổi `openapi.yaml` / HTTP API **KHÔNG ảnh hưởng SDK**. Đừng "sync" nhầm. Contract của SDK là **CDN artifact layout** + **CDP behavior**, không phải REST API.

## 2. Identity

| | Node | Python |
|---|---|---|
| Tên | `brproxies-sdk` v0.1.5 (ESM) | `brproxies` v0.1.5 (shim → `shardx`) |
| Runtime | Node ≥18 | Python ≥3.9 |
| Build | `npm run build` (tsc → `dist/`) | hatchling (wheel: `brproxies` + `shardx`) |
| Deps | adm-zip, patchright ^1.49, socks-proxy-agent, undici | httpx[socks]≥0.27, patchright≥1.49 |

`brproxies/__init__.py` là shim: `from shardx import *`. Code thật ở `shardx/`.

## 3. Surface (giống nhau 2 lang, camelCase vs snake_case)

Facade `BrProxies` (alias `ShardX`):
- `listProfiles/list_profiles(platform?)`, `randomProfile/random_profile(platform?)`
- `launch(fingerprint?, {platform, randomize, proxy, cdp, headless, webrtc, screenMode…})` → `BrowserSession`
- `session(...)` → patchright `Browser` (Python: async context manager)
- `checkProxy/check_proxy(url)`

Module (cả 2): `runtime` (CDN download/etag cache), `profile` (`Profile`, `FingerprintLibrary`), `browser`, `proxy` (`parseProxy`/`probeUdp`), `geo`, `randomize`, `host`, `screen`, `autoResolve`.

## 4. Parity rules (MANDATORY)

- **Thay đổi 1 SDK phải mirror sang SDK kia.** Cùng facade, cùng module split, cùng public symbol; chỉ khác naming convention.
- Node re-export ở `src/index.ts`; Python `__all__` ở `shardx/__init__.py`.
- **Đồng bộ version**: `package.json`, `pyproject.toml`, và `shardx/__init__.py` `__version__`. (Hiện có drift: package/pyproject `0.1.5` nhưng `__version__ = "0.1.0"` — sửa khi đụng.)
- Node ship compiled `dist/` — chạy `npm run build` sau khi sửa `src/`, commit `dist` nếu repo track.

## 5. Build & check

```bash
cd sdks/node && npm run build      # tsc → dist
cd sdks/python && python -m build  # hatchling wheel (nếu cần)
```

Không có unit-test runner riêng trong repo cho SDK — verify bằng smoke script `launch()`/`session()` hoặc so shape với SDK kia. Khi thêm method, đảm bảo type (`.d.ts`) + Python type hint khớp.
