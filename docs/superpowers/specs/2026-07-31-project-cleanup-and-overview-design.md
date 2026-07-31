# Project Cleanup & Architecture Overview — Design Spec

Ngày: 2026-07-31

## Bối cảnh

Review một lượt toàn repo BrProxies để tạo "bản clean project": vừa **dọn dẹp** các
artifact/credential/doc thừa đang tracked, vừa sản xuất **tài liệu tổng quan kiến trúc**
đọc-hiểu-nhanh mà không đụng code chức năng.

Repo là monorepo đa toolchain: Tauri (Rust) + React/TS frontend + Node automation/MCP +
Python sidecars (proxypool, android_manager) + SDKs. Cấu trúc lõi **đúng và đầy đủ tính năng** —
mục tiêu KHÔNG phải tái cấu trúc lớn mà là loại bỏ nhiễu và tài liệu hóa cho sạch.

Phạm vi gồm hai sản phẩm độc lập:
- **Phần A** — Cleanup actionable (đụng file/git).
- **Phần B** — Tài liệu overview (chỉ tạo 1 file docs mới, không đụng code).

---

## Phần A — Cleanup

### A0 — Trạng thái đã xác minh (tại thời điểm viết spec)

| Đối tượng | Trạng thái git | Hành động |
|-----------|----------------|-----------|
| `account-keeper-input.txt` | **đã staged deletion** (`D`), không còn trên đĩa | Thêm gitignore + commit |
| `dump.rdb` (41KB) | **tracked** | `git rm` + gitignore |
| `account-keeper-result.json` | không tracked, đã có trong `.gitignore` | Không làm gì |
| `docs/phonegrid-like-android-platform-plan.md` | tracked, không file nào tham chiếu | `git rm` |

### A1 — Credential leak (P0)

- **Vấn đề:** `account-keeper-input.txt` từng chứa credential thật dạng
  `email|password|TOTP-secret`, đã commit ở `8a30743`. Vi phạm security invariant của
  project ("never paste production credentials into files/tests/logs").
- **Quyết định của user:** Chỉ xóa khỏi tracking + gitignore. **KHÔNG** rewrite/scrub history
  (credential vẫn tồn tại trong commit `8a30743`).
- **Hành động:**
  1. File đã staged deletion — giữ nguyên, sẽ được commit trong batch cleanup.
  2. Thêm `account-keeper-input.txt` vào `.gitignore` (mục "Account Keeper generated runtime").
- **Cảnh báo còn hiệu lực (nằm ngoài phạm vi code):** Vì history vẫn lộ credential, account
  `jaco329zoe@gmail.com` phải coi như đã bị lộ → **đổi password + reset TOTP secret**. Đây là
  thao tác thủ công của operator, agent không thực hiện.
- **Kiểm chứng đường dẫn thật:** code (`account_keeper_agent.rs:256,270`) đọc từ
  `C:\private\account-keeper-input.txt` (đường dẫn local ngoài repo), nên file root này thừa,
  xóa không ảnh hưởng chức năng.

### A2 — Runtime artifact (P1)

- **`dump.rdb`:** Redis snapshot sinh lúc chạy (bundled Windows Redis trong `redis/`),
  không phải source. `git rm dump.rdb`, thêm `dump.rdb` (hoặc `*.rdb`) vào `.gitignore`
  mục "Python / ProxyPool artifacts".
- **`account-keeper-result.json`:** đã untracked + đã ignore → không cần làm gì. Ghi nhận để
  không "sửa nhầm".

### A3 — Doc cũ ngoài luồng (P1)

- **`docs/phonegrid-like-android-platform-plan.md`:** plan Android cũ, không doc/code nào
  tham chiếu; `android_manager/` sidecar đã build. **Quyết định user: xóa.** `git rm`.

### A4 — GIỮ NGUYÊN — không đụng (tránh phá workflow)

Các file dưới trông "bẩn" nhưng **được README + build workflow phụ thuộc trực tiếp**.
Xóa/di chuyển sẽ hỏng luồng build. Chỉ tài liệu hóa trong Phần B, KHÔNG chạm ở đợt này:

- `smart launch/` (build.bat, run.bat, run-redis.bat, smart-build.ps1, test-*.ps1) —
  README.md:49-78 hướng dẫn dùng trực tiếp.
- `cleanup-proxypool.ps1` — được `run.bat` gọi để dừng ProxyPool sidecar cũ.
- `redis/redis-server.exe`, `redis/redis-cli.exe`, `redis/*.conf` — bundled Redis cho
  ProxyPool trên Windows; `run-redis.bat` khởi động.

> Ghi chú tương lai (ngoài phạm vi spec này): nếu muốn đổi tên `smart launch/` (tên có dấu
> cách) → `scripts/` cho gọn, đó là thay đổi breaking cần sửa đồng bộ README + mọi tham chiếu,
> làm ở task riêng.

### A5 — Cập nhật `.gitignore`

Thêm 2 dòng:
```
# ===== Account Keeper generated runtime =====
account-keeper-input.txt      # (thêm mới)
# ===== Python / ProxyPool artifacts =====
dump.rdb                      # (thêm mới)
```

### A6 — Commit

Một commit gộp: `chore: remove leaked credential file, redis dump, stale android plan; ignore runtime artifacts`.
Không force-push (không rewrite history).

---

## Phần B — Tài liệu tổng quan kiến trúc

### Vị trí
`docs/project-overview.md` (theo lựa chọn user: đặt trong `docs/`).

### Nội dung & format (đọc-hiểu, không đụng code)

1. **Một dòng mô tả** + bảng "subsystem × toolchain × mục đích":

   | Subsystem | Thư mục | Toolchain | Vai trò |
   |-----------|---------|-----------|---------|
   | Rust backend | `src-tauri/` | Cargo/axum/tokio | HTTP API, launch, profile, proxy, cookies, Account Keeper daemon |
   | Frontend | `src/` | React 19/Vite/TS | UI |
   | Automation worker | `automation/` | Node/Patchright/CDP | Account Keeper worker + adapters |
   | MCP server | `mcp/` | Node stdio | Bridge HTTP API + CDP |
   | SDKs | `sdks/node`, `sdks/python` | — | Client libs |
   | ProxyPool | `proxypool_service/` | Python FastAPI + Redis | Proxy pool |
   | Android Manager | `android_manager/` | Python FastAPI | Android sidecar |
   | Extension | `extension/` | — | Chrome ProxyPool extension |
   | Build helpers | `smart launch/`, `redis/` | .bat/.ps1 | Build + bundled Redis |

2. **Cây thư mục annotate** (chỉ mức top-level + `src-tauri/src/` files chính), mỗi dòng 1 chú thích ngắn.

3. **Sơ đồ data-flow Account Keeper** (text/ASCII): MCP/API → daemon (FIFO, 1 job) →
   Rust launch profile → Node worker qua CDP → adapter. Ghi rõ ranh giới bảo mật
   (TOTP ở Rust, chỉ path qua MCP, DPAPI state).

4. **Entry points & commands**: trích từ CLAUDE.md — build, test (vitest scope caveat,
   `node --test`), account-keeper agent/QA. Không lặp lại nguyên văn CLAUDE.md, chỉ tổng hợp
   dạng bảng tra cứu nhanh.

5. **Bảng "artifact vs source"**: nêu rõ file nào là runtime-generated (không commit) để
   tránh nhầm lẫn tương lai.

### Nguyên tắc
- Không trùng lặp README (README là hướng dẫn dùng; overview là bản đồ kiến trúc cho dev/agent).
- Format đẹp: bảng markdown, cây thư mục trong code block, sơ đồ ASCII.
- Không đụng bất kỳ file code/config nào ngoài việc tạo mới file này.

---

## Kiểm chứng (Verify)

- **A:** `git status` sạch sau commit; `git ls-files` không còn `account-keeper-input.txt`,
  `dump.rdb`, `phonegrid-...plan.md`; `git check-ignore` xác nhận cả hai file mới bị ignore;
  build workflow (`smart launch/`, `redis/`) còn nguyên.
- **B:** `docs/project-overview.md` tồn tại, mọi đường dẫn/subsystem nêu trong đó khớp cây
  thư mục thật; không có placeholder/TODO.

## Ngoài phạm vi

- Rewrite/scrub git history (user chọn không làm).
- Đổi tên `smart launch/` hay di chuyển script (breaking, task riêng).
- Đổi/reset credential account bị lộ (thao tác thủ công của operator).
- Các finding chức năng Account Keeper (đã có spec riêng `...-review-fixes.md`).
