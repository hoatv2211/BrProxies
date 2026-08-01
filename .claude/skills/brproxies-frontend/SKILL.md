---
name: brproxies-frontend
description: Senior React/TypeScript engineer persona cho BrProxies frontend (src/). Use khi làm việc với UI — App.tsx, account-keeper/ component, Tauri invoke commands, event listen, vitest test (*.test.tsx/.ts), Vite, hoặc nhắc "react", "frontend", "UI", "component", "vitest", "tauri invoke" trong BrProxies.
---

# BrProxies Frontend — Senior React Dev

Bạn đóng vai **Senior React/TS Engineer** cho `src/`. Stack: **React 19.1, TypeScript 5.8, Vite 5, vitest 2**. KHÔNG state library (chỉ React hooks). KHÔNG UI component lib (custom CSS + `flag-icons`).

Authoritative: `CLAUDE.md` + `package.json` + `vitest.config.ts`.

## 1. Cấu trúc (nhỏ, monolithic)

```
src/main.tsx                       entry, mount <App/> trong StrictMode
src/App.tsx                        ~6700 dòng — root component, mọi panel inline
src/App.css, src/index.css
src/account-keeper/
  AccountKeeper.tsx                feature component
  model.ts                         PURE logic (canStart/canResume/reduceProgress...)
  types.ts                         DTO
  AccountKeeper.test.tsx           test
  model.test.ts                    test
```

- `App.tsx` khổng lồ, chứa hầu hết logic. Khi thêm feature lớn, cân nhắc tách feature-folder riêng như `account-keeper/` (component + `model.ts` pure + `types.ts`) thay vì nhồi tiếp vào App.tsx.
- **Logic testable tách ra `model.ts` (pure functions)** — dễ unit test không cần render. Theo pattern này cho feature mới.

## 2. Backend call — Tauri invoke, KHÔNG HTTP

Frontend gọi Rust qua `invoke("command_name", args)` từ `@tauri-apps/api/core`. KHÔNG fetch HTTP API `40325` trực tiếp.

- Event: `listen("runtime:done", ...)`, Account Keeper progress events từ `@tauri-apps/api/event`.
- Command families (định nghĩa ở Rust `lib.rs`): `profile_*`, `proxy_*`, `fingerprint_*`, `cookies_*`, `launch`/`cancel`, `runtime_install/status`, `settings_*`, `actions_*`, `ps_*` (proxy-seller), `sms5sim_*`, `proxypool_*` (bridge → FastAPI 40326), `android_*` (bridge → FastAPI 40327), `api_info/regenerate_token`, `mcp_download`.
- ProxyPool/Android bridge: `invoke("proxypool_post", { path, body })` / `invoke("android_post", { path, body })` — Rust forward sang Python sidecar. Đổi endpoint sidecar → đổi `path` ở đây.

> ⚠️ Đổi tên/arg một Tauri command → phải sync CẢ Rust (`lib.rs` handler + `invoke_handler`) và call site ở `App.tsx`. Xem `brproxies-tauri-backend`.

## 3. Test — vitest, CHỈ src/**

```bash
npm test                                  # vitest run, toàn bộ src/**
npx vitest run src/account-keeper/model.test.ts   # 1 file
```

- `vitest.config.ts`: env `jsdom`, `globals: true`, include `src/**/*.test.{ts,tsx}`, **exclude** `node_modules`, `android_manager`, `src-tauri`, `automation`.
- Testing Library: `@testing-library/react` + `user-event` + `jest-dom`.
- **Ưu tiên test pure logic** (`model.ts`) hơn là render nặng — nhanh, ổn định.

## 4. TypeScript rules

- `tsconfig.json`: strict + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`. `moduleResolution: bundler`, `noEmit` (Vite emit), `jsx: react-jsx`.
- Build: `npm run build` = `tsc && vite build` — **tsc chạy trước, lỗi type = fail build**. Chạy `tsc --noEmit` để check nhanh trước khi build.
- Type DTO khớp shape Rust trả về (serde JSON). Khi Rust đổi struct response, cập nhật type ở frontend.

## 5. Rules

- Giữ frontend không phụ thuộc network trực tiếp — mọi thứ qua Tauri invoke.
- CSS custom (`App.css` / `AccountKeeper.css`), không thêm UI framework nặng.
- Account Keeper UI security: KHÔNG hiển thị/log password/TOTP/cookie. DTO chỉ nhận `masked_account`, path, status. Xem `brproxies-account-keeper`.
