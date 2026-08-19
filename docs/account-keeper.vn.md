# Account Keeper

[README](../README.vn.md) | [English](account-keeper.md)

Account Keeper là quy trình trên BrProxies dành cho Windows 10/11 để đổi mật
khẩu cho các tài khoản do người vận hành sở hữu hoặc được ủy quyền quản lý rõ
ràng. Bản MVP xử lý từng tài khoản một và ánh xạ mỗi tài khoản vào một profile
BrProxies lâu dài.

## An Toàn Và Phạm Vi

Account Keeper thay đổi thông tin đăng nhập. Đọc các giới hạn này trước khi
dùng:

- Chỉ dùng cho tài khoản do người vận hành sở hữu hoặc được ủy quyền quản lý.
- Không dán credential production vào tài liệu, test, issue, log, ảnh chụp,
  development chat hoặc support chat.
- Account Keeper không giải hoặc bypass CAPTCHA, device approval, cảnh báo đăng
  nhập bất thường, email verification hay cơ chế bảo mật khác.
- Tính năng không đăng nhập inbox và không tự động lấy nội dung email.
- Khi đổi email, có thể dùng connector mailbox loopback do người vận hành cấu hình
  để lấy mã sáu chữ số. Nếu connector không hoạt động, profile vẫn mở để xác minh thủ công.
- Social login qua Google, Microsoft, Apple hoặc identity provider khác chưa
  được hỗ trợ trong MVP.
- Tính năng không export cookie, browser session hoặc authorization header. Chỉ
  chức năng export Codex rõ ràng ở section 04 mới export OAuth token sau khi người
  vận hành authorize profile đã verify và xác nhận xử lý plaintext.
- TOTP secret luôn ở local. Rust tạo code sáu chữ số có thời hạn ngắn và chỉ
  gửi code đó cho worker khi form TOTP mong đợi đang hiển thị.

Text dán, file input đã chọn và file output được yêu cầu đều chứa secret
plaintext. Text đã dán có thể vẫn lộ qua system clipboard, clipboard history
hoặc process memory. Xóa nội dung nhạy cảm khỏi clipboard sau khi dán, và chỉ
lưu file input/output plaintext ở vị trí local đáng tin cậy với quyền file
Windows phù hợp.

## Nền Tảng Và Runtime

- Nền tảng hỗ trợ: Windows 10 và Windows 11.
- Mô hình chạy: mỗi thời điểm chỉ có một tài khoản và một worker.
- Mô hình browser: mỗi tài khoản đã normalize có một profile BrProxies lâu dài.
- Release build chứa sẵn Windows Node runtime, Account Keeper worker,
  Patchright, Patchright Core, protocol module và provider adapter.
- Worker kết nối profile BrProxies đã launch qua CDP. Worker không download hoặc
  launch một browser Playwright riêng.
- Debug build ưu tiên resource đã bundle nếu có. Nếu thiếu, fallback chỉ dành
  cho debug dùng thư mục `automation/` và yêu cầu system `node` trong `PATH`.
  Release build không dùng fallback này.

## Daemon Chạy Nền Và MCP

Bản BrProxies đã build tự khởi động Account Keeper daemon trong tiến trình ứng
dụng. Giữ BrProxies đang chạy khi job hoạt động; đóng MCP client không làm dừng
job hiện tại.

- Queue chạy FIFO và chỉ có một Account Keeper job active tại mỗi thời điểm.
- Request của job được lưu local trong file daemon được bảo vệ bằng DPAPI.
- MCP và Automation API chỉ nhận đường dẫn input/output local. Không truyền
  account, password, TOTP secret, cookie hoặc token trong tool arguments.
- Tạo job bắt buộc có `authorize_password_change: true`.
- Dùng `account_keeper_list_jobs` hoặc `account_keeper_get_job` để xem trạng
  thái đã redact. Response không chứa đường dẫn input/output hay credential.
- Chỉ dùng `account_keeper_continue_job` sau khi người vận hành tự hoàn tất
  CAPTCHA, email verification, device approval hoặc security challenge đang
  hiển thị.
- Sau khi BrProxies restart, job bị gián đoạn chuyển thành
  `recovery_required`. Daemon không tự resume; phải gọi
  `account_keeper_resume_job` rõ ràng.
- Dùng `account_keeper_cancel_job` để hủy theo password-state safety rules.
  Hủy sau password submission có thể tạo trạng thái critical/unknown.

Các MCP tool:

```text
account_keeper_create_job
account_keeper_list_jobs
account_keeper_get_job
account_keeper_continue_job
account_keeper_resume_job
account_keeper_cancel_job
```

## Chuẩn Bị Dữ Liệu Input

Dùng text dán hoặc file plaintext UTF-8. Cả hai mode input đều dùng format sau,
với mỗi record trên một dòng:

```text
account|current_password|optional_totp_secret
```

Riêng **Change email**, thêm email mới ở field thứ tư:

```text
current_email|current_password|optional_totp_secret|new_email
```

Email đầu tiên dùng để tìm profile hiện tại. Field thứ tư là email mới và chỉ
được ghi nhận sau khi provider xác minh thành công.

Ví dụ synthetic bắt buộc:

```text
owner@example.test|current-password|JBSWY3DPEHPK3PXP
```

Tài khoản không dùng TOTP vẫn cần delimiter cuối:

```text
owner@example.test|current-password|
```

Quy tắc parser:

- Bỏ qua dòng trống.
- Một dòng là comment khi ký tự đầu tiên sau khoảng trắng là `#`.
- Mỗi dòng dữ liệu phải có ít nhất hai delimiter `|`.
- Account là mọi nội dung trước `|` đầu tiên; khoảng trắng hai đầu được trim và
  account không được rỗng.
- TOTP secret là mọi nội dung sau `|` cuối cùng; khoảng trắng hai đầu được trim.
- Current password là mọi nội dung giữa delimiter đầu và cuối. Byte, khoảng
  trắng và các ký tự `|` bổ sung được giữ nguyên chính xác.
- Account được normalize bằng trim rồi lowercase. Account trùng nhau sau khi
  normalize làm toàn bộ input bị từ chối trước khi batch bắt đầu.
- TOTP rỗng được chấp nhận. Giá trị không rỗng phải là Base32 hợp lệ. Base32
  không phân biệt hoa thường; space và hyphen bị bỏ qua; padding `=` hợp lệ ở
  cuối được chấp nhận.
- Lỗi validation báo số dòng nhưng không lặp lại password hoặc TOTP secret.
- Field thứ tư chỉ hợp lệ với **Change email**, phải là email hợp lệ và phải khác
  email hiện tại sau khi normalize.

Ví dụ password có delimiter bên trong:

```text
owner@example.test|part|two|JBSWY3DPEHPK3PXP
```

Password sau khi parse là `part|two` vì parser dùng delimiter đầu tiên và cuối
cùng.

## Password Template

Một template áp dụng cho toàn bộ batch. Grammar chính xác:

```text
prefix{random:N}suffix
```

Quy tắc:

- Template phân biệt hoa thường và phải có đúng một placeholder `{random:N}`.
- `N` chỉ gồm chữ số ASCII và phải từ 8 đến 64.
- Prefix và suffix là text literal, có thể rỗng.
- Độ dài password cuối cùng, gồm cả prefix và suffix, phải từ 12 đến 128 ký tự.
- Phần random chỉ dùng chữ hoa, chữ thường, chữ số và `!@#$%^&*_-+=?`.
- Mỗi phần random có ít nhất một chữ hoa, một chữ thường, một chữ số và một ký
  hiệu.
- Generator dùng nguồn random mật mã của hệ điều hành.
- Password sinh ra là duy nhất trong batch. Generator thử tối đa 128 lần để
  tìm giá trị duy nhất.

Template synthetic hợp lệ:

```text
BrP@{random:16}!
team-{random:24}
{random:12}-AK
```

Ví dụ không hợp lệ gồm thiếu placeholder, có hai placeholder, `{random:7}`,
`{random:65}`, độ dài không phải số, hoặc template tạo password cuối cùng ngoài
12-128 ký tự.

## Bắt Đầu Batch

1. Mở **Account Keeper** trong BrProxies.
2. Chọn **Login GPT**, **Change password**, **Change 2FA** hoặc **Change email**.
3. Giữ mode **Paste text** mặc định và dán mỗi record trên một dòng, hoặc bấm
   **Choose file**, sau đó bấm **Browse** dưới **Input file** và chọn file input
   plaintext UTF-8.
4. Với text dán, bấm **Validate Input** để validate rõ ràng. File được validate
   ngay sau khi chọn.
5. Với operation thay đổi, giữ đường dẫn mặc định
   `%USERPROFILE%\Documents\account-keeper-result.json`, hoặc bấm **Browse**
   dưới **Output file** để chọn đường dẫn output JSON plaintext khác.
6. Chỉ với **Change password**, nhập password template rồi bấm **Validate Template**.
7. Kiểm tra identity account đã mask, tổng số account đã parse và lỗi theo dòng.
8. Xác nhận rằng input đang dùng chứa secret plaintext và output cũng vậy.
9. Tùy chọn bật **Keep profile running after completion**. Mặc định toggle này
   tắt.
10. Bấm **Start Batch** và xác nhận operation đã chọn.

### Connector mailbox tùy chọn

Cấu hình tại **Settings** > **Account Keeper email verification**. Endpoint phải
dùng HTTP loopback và chỉ trả một trong các response sau:

```json
{"status":"code","code":"123456"}
{"status":"pending"}
{"status":"manual"}
```

Timeout, lỗi connector hoặc `manual` sẽ fallback sang **Continue** thủ công.
Token connector chỉ nằm trong settings local, không gửi cho browser worker.

Mỗi lần validate hoặc start đều gửi `request.source` qua IPC local từ React sang
Tauri. Paste mode gửi `{ kind: "inline", text }`; file mode gửi
`{ kind: "file", path }`. Rust parse text đã dán trong RAM và đọc trực tiếp file
đã chọn; không tạo file input plaintext tạm. Khi báo trạng thái, UI nhận identity
account đã mask, profile ID, stage,
số lần thử, timestamp và lỗi đã redact. Sau khi **Start Batch** thành công, UI
xóa draft đã dán. Việc này không erase hoặc zeroize các bản sao có thể còn
trong process memory.

- Text dán không bao giờ được lưu vào settings, checkpoint, job, event, log,
  diagnostics hoặc output metadata.
- Việc chuyển mode giữ draft chưa gửi nhưng xóa validation cũ. **Start Batch**
  thành công xóa draft text đã dán.

## Cách Batch Hoạt Động

Với mỗi tài khoản, Account Keeper:

1. Resolve hoặc tạo profile BrProxies lâu dài của account.
2. Launch profile với CDP được bật.
3. Start một Node/Patchright worker mới cho account.
4. Classify session hiện tại. Nếu profile đã đăng nhập, worker bỏ qua việc nhập
   credential và mở settings phù hợp với operation đã chọn.
   Nếu chưa đăng nhập, worker dùng email/password trực tiếp.
5. Chỉ tạo TOTP local khi form TOTP đang hiển thị yêu cầu.
6. Pause để người vận hành xử lý khi có security challenge.
7. Với **Change 2FA**, authorize rồi xóa authenticator factor cũ, mở enrollment
   mới và chỉ commit secret mới sau khi verify. Lỗi sau ranh giới authorize xóa
   được xem là `critical` vì factor đang hoạt động có thể không còn xác định.
8. Submit password đã sinh qua provider flow được hỗ trợ.
9. Đăng xuất rồi đăng nhập lại bằng password mới.
10. Chỉ đánh dấu password là `changed` sau khi đăng nhập mới được verify.
11. Update checkpoint và output plaintext theo cách atomic.
12. Stop profile nếu keep-profile toggle không bật, rồi mới chạy account tiếp
    theo.

Stage bình thường còn có `changing_totp`, `verifying_new_totp`, `changing_email`,
`waiting_email_verification`, `verifying_new_email` và `success`. State ngoại lệ gồm
`waiting_manual`, `failed`, `critical` và `cancelled`.

## Điều Khiển Batch

- **Pause After Current** để account hiện tại đi tới ranh giới an toàn, sau đó
  pause trước account tiếp theo. Nút này không cắt ngang password submission
  đang chạy.
- **Cancel Batch** hủy thao tác hiện tại và queue còn lại. Cancel trước khi
  submit password giữ `password_state: original`; cancel sau khi submit trở
  thành critical vì chưa biết password nào đã được chấp nhận.
- **Keep profile running after completion** quyết định process của profile hoàn
  tất bình thường có tiếp tục mở hay không. Profile lâu dài và user-data vẫn
  được ánh xạ kể cả khi process đã stop.
- **Logs** hiển thị snapshot đã redact của job đang chọn: timestamp, account đã
  mask, stage, số lần thử và canonical error code.
- **Clean** chỉ xóa progress checkpoint terminal có status `completed`,
  `failed`, `cancelled` hoặc `abandoned`. Nút bị disable với job đang chạy và
  `critical`; profile đã verify trong section 04 không bị xóa.

## Profile Đã Verify

Section **04 Profiles** chỉ liệt kê record trong vault đã verify với
`status: success`.

- **Run** launch persistent profile đã ánh xạ.
- **Delete** stop profile, xóa browser data local và xóa mapping trong Account
  Keeper vault, bao gồm Codex OAuth record được bảo vệ nếu có.
- **Connect Codex** mở luồng authorize Codex chính thức trong profile đã ánh xạ.
  **Reconnect Codex** chỉ thay credential cũ khi email token trả về khớp account
  đã verify trong vault.
- **Export** có action copy/lưu cho một account sẵn sàng. Action bulk ở đầu section
  export mọi account sẵn sàng thành một mảng JSON cho 9Router hoặc Cockpit.

## Can Thiệp Thủ Công

Khi Account Keeper vào `waiting_manual`, worker vẫn kết nối nhưng không thực
hiện browser action nào.

- Bấm **Open Profile** để đưa browser profile đã ánh xạ ra trước.
- Tự hoàn thành challenge của provider.
- Chỉ bấm **Continue** sau khi trang đã tới bước được hỗ trợ. Worker sẽ đánh giá
  lại trang trước khi hành động.
- Bấm **Mark Failed** để kết thúc account như một lỗi đã biết thay vì tiếp tục.
  Account sau có thể chạy nếu không tồn tại critical state.

Manual reason gồm CAPTCHA, email verification, security challenge, unusual
login approval và unknown challenge. Account Keeper không giải, né hoặc đoán
lặp để vượt qua các kiểm tra này.

### Khôi Phục Password OpenAI Và ChatGPT

Adapter OpenAI/ChatGPT dùng đăng nhập email/password trực tiếp. Việc đổi
password có thể phải dùng flow **Forgot Password** chính thức của provider. Nếu
OpenAI yêu cầu kiểm tra email, Account Keeper pause để người vận hành tự verify:

1. Bấm **Open Profile**.
2. Tự mở tài khoản email và dùng recovery message chính thức.
3. Hoàn thành provider flow trong profile BrProxies đã ánh xạ.
4. Quay lại Account Keeper và bấm **Continue**.

Account Keeper không đăng nhập inbox, đọc message, lấy link hoặc tuyên bố tự
động hóa email verification.

## Critical Recovery

`credential_state_unknown` là safety state nghiêm trọng. Nó có nghĩa password
submission có thể đã xảy ra nhưng Account Keeper không verify được password cũ
hay password đề xuất hiện còn hợp lệ.

Hành vi critical là cố định:

- Account chuyển thành `critical` với `password_state: unknown`.
- Toàn bộ batch dừng ngay. Không account nào phía sau được start.
- Browser profile bị ảnh hưởng được giữ mở để recovery, bất kể keep-profile
  setting thông thường.
- Checkpoint và output giữ state unknown. Account Keeper không đoán password
  nào đã thành công.
- Cancel sau khi action submit password bắt đầu cũng tạo state này.

Dùng **Open Profile** và recovery process chính thức của provider để xác định
một credential hợp lệ đã biết. Không resume queue còn lại khi credential state
vẫn unknown. Nếu job không thể tiếp tục an toàn, dùng **Abandon**; mapping
profile lâu dài vẫn được giữ. Chỉ dùng **Export Result** sau khi xác nhận thao
tác sẽ ghi state hiện tại có secret vào file JSON plaintext.

## Checkpoint, Resume, Abandon Và Export

Account Keeper không tự động resume password-changing job khi BrProxies start.

- **Resume** tiếp tục job chưa hoàn tất và không critical từ account queued tiếp
  theo. Job `waiting_manual` có thể mở lại profile và tiếp tục sau khi người vận
  hành hoàn thành challenge.
- **Abandon** dừng theo dõi job chưa hoàn tất nhưng giữ mapping account-profile.
- **Export Result** ghi result hiện tại vào đường dẫn JSON plaintext đã chọn sau
  khi người vận hành xác nhận rõ ràng.
- Có thể xem failed result qua UI state đã redact mà không decrypt credential
  vào React.

## Profile Mapping Và Dữ Liệu Local

Account identifier được normalize và chuyển thành stable account key. Account
mới nhận profile lâu dài với display name đã mask như `acct-1a2b3c4d`; batch sau
tái sử dụng `profile_id` đã lưu.

Dữ liệu Windows nằm dưới:

```text
%APPDATA%\brproxies-launcher\account-keeper\
```

File quan trọng:

- `vault.bin` chứa account identifier, password hợp lệ đã biết hiện tại, TOTP
  secret tùy chọn, profile mapping, password state và status metadata. File này
  được mã hóa local bằng Windows DPAPI.
- `jobs\<batch_id>.json` chứa metadata để resume như profile ID, state, attempts,
  timestamp, template, output path và lỗi đã redact. File này không chứa
  plaintext password hoặc TOTP secret.
- Output JSON do người vận hành chọn là plaintext và có thể chứa account,
  password hợp lệ và TOTP secret.

DPAPI bảo vệ internal vault cho Windows security context hiện tại. DPAPI không
bảo vệ file input hoặc output plaintext đã chọn.

## Output JSON

Schema version 1:

```json
{
  "schema_version": 1,
  "batch_id": "batch-synthetic-001",
  "updated_at": "2026-07-29T00:00:00Z",
  "accounts": [
    {
      "account": "owner@example.test",
      "password": "synthetic-generated-password",
      "password_state": "changed",
      "totp_secret": "JBSWY3DPEHPK3PXP",
      "profile_id": "profile-synthetic-001",
      "status": "success",
      "last_verified_at": "2026-07-29T00:00:00Z"
    }
  ]
}
```

Quy tắc output:

- `password` là password hợp lệ gần nhất đã biết.
- `password_state` là `original`, `changed` hoặc `unknown`.
- `status` là account state terminal hoặc checkpointed hiện tại.
- Account failed đã biết giữ password gốc.
- Account critical dùng `password_state: unknown` và dừng batch.
- `totp_secret`, `last_verified_at` và `error` bị bỏ qua khi không có giá trị.
- File được update atomic sau mỗi account bằng cách chỉ replace destination sau
  khi JSON mới serialize thành công.
- Account Keeper không tạo bản backup, diagnostic hoặc telemetry của output
  này.

Coi output như credential vault. Hạn chế quyền truy cập, chuyển nó tới vị trí
bảo mật cuối cùng sớm và xóa an toàn các bản plaintext cũ.

## Xử Lý Sự Cố

| Code hoặc triệu chứng | Ý nghĩa và cách xử lý |
| --- | --- |
| `invalid_credentials` | Credential direct-login hiện tại bị từ chối. Account Keeper không retry. Verify account và password ngoài batch rồi chuẩn bị file input đã sửa. |
| `totp_rejected` | TOTP đã submit bị từ chối. Account Keeper có thể chờ cửa sổ 30 giây tiếp theo và retry một lần; lần từ chối thứ hai cần manual intervention. Kiểm tra đồng hồ Windows và Base32 secret. |
| `waiting_manual` | CAPTCHA, email verification, unusual login hoặc security challenge khác đang hiển thị. Dùng **Open Profile**, tự hoàn thành, rồi chọn **Continue** hoặc **Mark Failed**. |
| `flow_changed` | Cấu trúc trang hoặc semantic state được hỗ trợ không còn được nhận diện. Dừng; không click bằng phỏng đoán hoặc vị trí gần đúng. Update provider adapter trước khi thử lại. |
| `unsupported_login_method` | Account dùng Google, Microsoft, Apple hoặc login method chưa hỗ trợ. MVP chỉ hỗ trợ direct email/password. |
| `navigation_failed` | Navigation hoặc network lỗi nhiều lần. Kiểm tra kết nối, proxy, DNS và provider availability. Coordinator có thể retry tối đa ba lần với bounded backoff. |
| `browser_crashed` hoặc lỗi CDP | Browser đã đóng hoặc CDP connection không còn dùng được. Account Keeper có thể restart profile và worker một lần. Nếu lặp lại, dừng process khác đang dùng profile, verify BrProxies runtime rồi launch lại. |
| `worker_not_ready` hoặc protocol failure | Worker file, adapter flow hoặc stdio protocol không start được. Build lại worker resource và kiểm tra log đã redact. |
| `credential_state_unknown` | Critical recovery state sau khi password submission có thể đã bắt đầu. Batch dừng và profile được giữ mở. Xác định credential hợp lệ qua recovery flow chính thức trước khi tạo batch mới. |

Message liên quan runtime:

- `Account Keeper worker resources are missing; reinstall BrProxies`: resource
  release bị thiếu hoặc không đầy đủ.
- `Account Keeper bundled Node runtime is missing`: thiếu `node.exe` đã bundle.
- `Account Keeper bundled worker is missing`: thiếu worker entry point.
- `Account Keeper bundled Patchright dependency is missing` hoặc message tương
  đương cho Patchright Core: dependency trong bundle không đầy đủ.
- `Account Keeper debug mode requires Node.js on PATH`: cài Node 18 trở lên cho
  fallback system-Node chỉ dành cho debug, hoặc chuẩn bị bundled resource.

## Build Cho Developer

Chuẩn bị Windows worker bundle từ repo root:

```powershell
npm.cmd run build:account-keeper-worker
```

Command này:

- cài production dependency cho `automation/` mà không download browser;
- download Windows x64 Node archive đã pin trong `automation/node-runtime.json`;
- verify archive với SHA-256 đã cấu hình và danh sách checksum chính thức của
  Node;
- copy Node, worker module graph, provider adapter, Patchright và Patchright
  Core vào `src-tauri/resources/account-keeper/`;
- ghi và verify `manifest.json`.

`src-tauri/tauri.windows.conf.json` chạy frontend build cùng worker bundle
command trước Windows Tauri build, sau đó package
`resources/account-keeper/` thành application resource `account-keeper/`.

Chỉ trong debug mode, nếu thiếu bundled resource thì app fallback sang source
worker trong `automation/` và system `node` trong `PATH`. Không dựa vào fallback
này khi validate release installer.

## QA Tauri Synthetic Chỉ Dành Cho Development

Cài dependency worker cô lập một lần, sau đó chạy workflow QA Windows đầy đủ từ
repo root:

```powershell
npm.cmd ci --prefix automation --ignore-scripts
npm.cmd run qa:account-keeper-tauri
```

Command này khởi động fixture xác thực loopback và ứng dụng Tauri debug thật. QA
chỉ dùng credential synthetic và config root tuyệt đối, cô lập tại
`%TEMP%\BrProxies-AccountKeeper-QA`. QA bridge chỉ được bật trong Vite development
mode với `?account-keeper-qa=1`; release build không expose bridge này.

Workflow verify TOTP RFC 6238 do Rust tạo, manual challenge/Continue, đổi mật
khẩu, logout và login lại, output JSON atomic, tái sử dụng persistent profile,
và resume rõ ràng sau khi restart Tauri. Workflow cũng xác nhận filename profile
BrProxies bình thường không thay đổi. Cleanup xóa QA root và dừng child process.
Không thay fixture bằng account hoặc provider production.

## Export Codex Cho 9Router Và Cockpit

Section 04 có thể authorize Codex OAuth ngay trong từng persistent profile đã
verify. Bấm **Connect Codex** (hoặc **Reconnect Codex**) và hoàn tất xác nhận OpenAI
nếu profile hiển thị. Khi trạng thái sẵn sàng, **Export** có thể copy hoặc lưu mảng
JSON dùng trực tiếp cho 9Router hay Cockpit; dùng **Copy all** hoặc **Save all** để
export toàn bộ profile sẵn sàng cùng lúc. Rust refresh credential còn tối đa năm
phút trước khi tạo JSON. Nếu refresh lỗi, hãy reconnect profile thay vì export
credential cũ. Token không được render trong UI và chỉ lưu trong local vault được
bảo vệ. File JSON và clipboard là plaintext secret; hãy import sớm rồi bảo vệ hoặc
xóa sau khi dùng.
