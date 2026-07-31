# Account Keeper — Spec Tóm Tắt Điểm Cần Fix

Ngày: 2026-07-31

## Bối cảnh

Tài liệu tổng hợp kết quả review flow Account Keeper, đối chiếu với hai spec design
đã thực thi xong (daemon/MCP và missing-profile recovery — spec gốc đã dọn sau khi
tính năng hoàn thành; kiến trúc hiện hành phản ánh trong code).

Phạm vi review: coordinator + daemon Rust (`account_keeper.rs`, `account_keeper_daemon.rs`),
worker + protocol Node (`automation/account-keeper-*.mjs`), adapter provider
(`adapters/openai-chatgpt-v1.mjs`), và bề mặt MCP/HTTP API (`mcp/account-keeper-tools.js`, `api.rs`).

**Kết luận tổng:** Không có lỗi critical/high. Toàn bộ bất biến an toàn cốt lõi
(không đoán mò credential, không auto-resume sau restart, giữ pending password khi lỗi,
không báo success khi chưa verify mật khẩu mới, redact credential khỏi API/MCP/log)
đều được thực thi đúng, có phòng thủ nhiều lớp. Các điểm bên dưới là hoàn thiện độ bền
và một race condition hẹp cần vá trước khi ship.

Mỗi finding dùng ID ổn định (R = Rust, W = Worker/Node, A = Adapter) để tham chiếu chéo.

---

## P0 — Sửa trước khi ship

### R1 — TOCTOU: cancel một job queued có thể bị "hồi sinh"

- **Vị trí:** `src-tauri/src/account_keeper_daemon.rs:310-337` (`start_queued_job`), đường cancel `241-251`
- **Mức:** medium-high
- **Triệu chứng:** `tick()` chọn job queued qua `next_queued_job` rồi **nhả state lock**
  trước khi gọi `start_queued_job`. Hàm này re-fetch job theo id **nhưng không re-check status**,
  spawn batch, rồi set `item.status = "running"` vô điều kiện. Nếu user gọi `cancel_job(id)`
  đúng khe thời gian này, transition queued→cancelled bị ghi đè lại thành "running" và
  batch đổi mật khẩu **vẫn chạy dù đã bị cancel**. Trong domain này đổi mật khẩu là thao tác
  không hoàn tác được → vi phạm bất biến an toàn.
- **Fix đề xuất:** Trong `start_queued_job`, re-verify `status == "queued"` **dưới cùng một lock**
  trước khi spawn batch và trước khi ghi "running". Nếu đã đổi trạng thái (cancelled), bỏ qua.
- **Verify:** Test mô phỏng cancel chen giữa select và spawn; khẳng định batch không chạy và
  view cuối là `cancelled`.

### W1 — Worker treo vô hạn khi parent chết giữa lúc chờ

- **Vị trí:** `automation/account-keeper-worker.mjs:31-37`; các wait `flow:420-427` (authorization),
  `flow:466-483` (resume/totp_code)
- **Mức:** medium
- **Triệu chứng:** `process.stdin.on("end")` chỉ gọi `decoder.end()`, **không huỷ** `active.control`.
  Các wait `waitForExpected(resume|totp_code)` và authorization `submit_password`
  **không có timeout**. Nếu Rust (parent) chết hoặc ngừng gửi khi flow đang chờ ở cổng
  manual/TOTP/authorization, promise không bao giờ resolve → worker treo vô hạn
  (Windows không đảm bảo kill child, nhất là detached).
- **Fix đề xuất:** Khi stdin `end`, đẩy một `cancel` synthetic vào `active.control`; và/hoặc
  thêm timeout có giới hạn cho các wait TOTP/authorization ngắn hạn.
- **Verify:** Test đóng stdin khi worker đang chờ manual → worker thoát với mã lỗi `cancelled`
  trong thời gian giới hạn, không treo.

### A1 — Nhầm màn 2FA hợp lệ thành security challenge thủ công

- **Vị trí:** `automation/adapters/openai-chatgpt-v1.mjs:121` (regex challenge) vs `:127` (check TOTP)
- **Mức:** medium
- **Triệu chứng:** `classify()` kiểm regex `security_challenge`
  `/verify|security check|unusual activity/i` **trước** khi check `totp_required`.
  Một màn 2FA có tiêu đề chứa chữ "verify" (vd "Verify your identity") sẽ trả
  `manual_required/security_challenge` và dừng chờ operator thay vì tự điền TOTP.
  Hướng lệch là **an toàn** (hỏi người, không bao giờ bypass) nhưng làm hỏng automation
  TOTP không giám sát.
- **Fix đề xuất:** Ưu tiên kiểm `visible(oneTimeCode(page))` trước nhánh security_challenge,
  hoặc anchor regex challenge vào cụm không đụng tiêu đề 2FA chuẩn.
- **Verify:** Fixture màn 2FA tiêu đề "Verify your identity" → classify trả `totp_required`,
  không phải `manual_required`.

---

## P1 — Cần quyết định / hoàn thiện

### R2 — Recovery dead-end: pending-recovery chưa expose qua daemon

- **Vị trí:** `src-tauri/src/account_keeper_daemon.rs:257-270` (`resume_job`);
  `account_keeper.rs:1810-1832`, `1904-1906` (`resume_job` bail khi Unknown);
  `recover_headless_pending_credentials` chỉ nối qua CLI agent `account_keeper_agent.rs:170`
- **Mức:** medium (correctness/completeness, KHÔNG vi phạm invariant)
- **Triệu chứng:** Daemon `resume_job` delegate xuống `account_keeper::resume_job`, hàm này
  **bail** với mọi account có `password_state == Unknown`. Job crash giữa lúc đổi mật khẩu ở
  thời điểm restart chính là trạng thái Unknown → thành `recovery_required` nhưng
  `resume_job` luôn báo lỗi → job **kẹt `recovery_required` vĩnh viễn** qua đường daemon.
  Path phục hồi pending (`recover_headless_pending_credentials`) chỉ chạy được qua CLI agent.
  Hành vi này err *safe* (không đoán mò, không auto-resume) nên không phải lỗi an toàn,
  nhưng là ngõ cụt chức năng.
- **Hai lựa chọn (cần user chốt):**
  - **(a) Wire pending-recovery vào daemon:** cho `resume_job` daemon gọi được path
    `recover_headless_pending_credentials` để verify chỉ pending password, theo đúng
    missing-profile-recovery design. Nhiều việc hơn nhưng job không còn kẹt.
  - **(b) Xác nhận là chủ đích:** giữ nguyên, tài liệu hoá rằng job `recovery_required`
    qua daemon phải xử lý bằng CLI agent; bổ sung thông báo rõ trong response daemon.
- **Verify:** Theo lựa chọn — (a) test resume một job Unknown qua daemon xác minh chỉ pending;
  (b) test/doc khẳng định response daemon chỉ dẫn sang CLI, không tự resume.

---

## P2 — Robustness / dọn dẹp

| ID | Vị trí | Mức | Triệu chứng | Fix đề xuất |
|----|--------|-----|-------------|-------------|
| R3 | `account_keeper.rs:363, 1398-1402` | low | Timestamp lẫn format `@{unix_seconds}` so sánh lexical; sai thứ tự khi số giây đổi số chữ số (thực tế tới năm 2286). Format không nhất quán với ISO ở test khác. | Dùng thứ tự số hoặc chuẩn hoá về ISO cho mọi timestamp. |
| R4 | `account_keeper.rs:1079, 1354` | low | `merge_imports_and_checkpoint` tạo profile thay thế và ghi ra đĩa cho từng import, nhưng vault chỉ save một lần cuối `prepare_new_batch`. Import N+1 lỗi → profile 1..N nằm trên đĩa nhưng không được vault tham chiếu (orphan). | Persist vault tăng dần, hoặc cleanup profile chưa được tham chiếu khi prep lỗi. |
| W2 | `automation/account-keeper-worker.mjs:65` | low-med | Không đăng ký `browser.on("disconnected")`. Khi flow đang chờ command, CDP disconnect không được phát hiện (cộng hưởng W1). | Thêm handler `disconnected` → đẩy `cancel`/mã `browser_crashed` vào control. |
| W3 | `automation/account-keeper-flow.mjs:642-647` | low | Lỗi patchright không có `.code` → `normalizeFailureCode` mặc định `navigation_failed` (hoặc `credential_state_unknown`) thay vì `browser_crashed` khi CDP drop giữa page op. An toàn nhưng mã lỗi gây hiểu nhầm. | Nhận diện disconnect → map sang `browser_crashed`. |
| W4 | `automation/account-keeper-worker-runtime.mjs:103, 152-155` | low | `createControlledPageSession` mở `context.newPage()` nhưng `runStart` finally không gọi `pageSession.dispose()` / close page — chỉ `process.exit(0)`. Để lại tab blank mồ côi trong context. | Gọi `dispose()`/close page trong finally trước khi exit. |
| A2 | `adapters/openai-chatgpt-v1.mjs:546-555` | low | `forgotPasswordLocators` (kèm comment đa ngôn ngữ) được định nghĩa nhưng **không tham chiếu ở đâu**. Xử lý forgot-password đa ngôn ngữ mà commit message nhắc tới thực tế chưa nối vào flow. | Xoá dead code, hoặc wire vào nhánh identity-challenge (`:267-278`). |
| A3 | `adapters/openai-chatgpt-v1.mjs:121-124` | low | `unusual_login` bị gộp vào reason `security_challenge`, mất fidelity so với enum của spec. | Trả riêng reason `unusual_login` khi khớp `/unusual activity/`. |
| A4 | `adapters/openai-chatgpt-v1.mjs:195-201` | low | `classifyPasswordChange` chuyển một `security_challenge` thành `identity_challenge` (auto điền current password) khi có ô password. Origin đã assert về host OpenAI nên phạm vi giới hạn, nhưng màn security-challenge có ô password sẽ nhận submit tự động thay vì để operator xử lý. | Cân nhắc giữ manual khi màn được phân loại security_challenge, dù có ô password. |

---

## Đã xác nhận ĐÚNG (đừng "fix" nhầm)

**Daemon (daemon-mcp-design):**
- Một job active / FIFO order (`next_queued_job`, `tick`).
- State file DPAPI-protected + zeroize plaintext, có schema version.
- Restart → job đang active thành `recovery_required`, không bao giờ auto-resume; job queued giữ nguyên.
- `continue_job` chỉ nhận `waiting_manual`; `resume_job` chỉ nhận `recovery_required`.
- `authorize_password_change: true` bắt buộc; `CreateJobRequest` `deny_unknown_fields` chặn credential inline.
- `DaemonJobView` omit path/template; log dùng `safe_error_code` giới hạn `[a-z_]`, worker code/reason allow-list.

**Missing-profile recovery (recovery-design):**
- Resolve mapping trước verify; tạo đúng một profile thay thế trong folder `Account Keeper`;
  persist profile ID vào vault **trước** khi mở browser.
- Pending recovery verify **chỉ** pending password, không đoán mò old/new.
- `password_state` giữ Unknown tới khi browser sign-in thành công.
- Giữ pending password + checkpoint critical khi bất kỳ bước nào lỗi; không xoá profile/checkpoint cũ khi remap.

**Worker / protocol:**
- Secret TOTP không vào worker; worker chỉ nhận mã 6 số (`^\d{6}$`).
- Chống lộ field cấm chiều ra: đệ quy object/array, normalize key trước substring match.
- Success bắt buộc: change → logout → login lại bằng **mật khẩu mới** → verify signed-in.
- `credential_state_unknown` bật đúng tại điểm không hoàn tác; mọi lỗi sau đó không báo success.
- Dòng >64KB bị từ chối an toàn, buffer có chặn, không phình bộ nhớ.

**MCP / API:**
- Chỉ nhận input/output **path**; không nhận credential/cookie/token.
- Response redact qua whitelist `JOB_FIELDS`.
- Mọi route bind loopback `127.0.0.1` + yêu cầu Bearer JWT.
- Adapter không export cookie/session/token, không social login, không bypass captcha/email verify.

---

## Ngoài phạm vi

- Code patch cụ thể và thứ tự task chi tiết — để dành cho bước writing-plans nếu triển khai.
- Refactor không liên quan tới các finding trên.
