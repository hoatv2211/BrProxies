# Hướng dẫn sử dụng Graphify và Understand Anything hiệu quả trong BrProxies

> Áp dụng cho cấu hình project-local hiện tại của BrProxies: Graphify `0.9.50`, Understand Anything `2.9.4`, Codex Desktop trên Windows. Cập nhật ngày 26/08/2026.

Tài liệu này dành cho cả người phát triển hằng ngày và thành viên mới trong team. Mục tiêu không phải dùng càng nhiều skill càng tốt, mà là dùng đúng công cụ, đúng thời điểm, với lượng token và thời gian thấp nhất.

## 1. Mô hình tư duy

Hai bộ skill bổ sung cho nhau nhưng không có cùng nhiệm vụ:

| Công cụ | Vai trò chính | Hình dung đơn giản |
| --- | --- | --- |
| **Graphify** | Phân tích cấu trúc code deterministic, truy vấn quan hệ, đường đi và phạm vi ảnh hưởng | Máy X-quang của codebase |
| **Understand Anything** | Tạo giải thích ngữ nghĩa, dashboard, business domain, onboarding và review thay đổi | Bản đồ và lớp học của codebase |

### Quy tắc vàng

1. **Graphify trước** để lấy topology và bằng chứng cấu trúc với chi phí thấp.
2. **Understand Anything sau** khi cần diễn giải, dashboard, domain knowledge hoặc onboarding.
3. **Source code là bước xác minh cuối** trước khi sửa hoặc kết luận hành vi runtime.
4. Không chạy full rebuild của cả hai công cụ sau mỗi thay đổi nhỏ.

Luồng tối ưu:

```text
Câu hỏi hoặc task
    ↓
Graphify query/path/affected
    ↓
Đọc một tập file nhỏ đã được khoanh vùng
    ↓
Understand Explain/Chat/Domain nếu cần diễn giải sâu
    ↓
Sửa code + chạy test/build liên quan
    ↓
Graphify update + Understand Diff
```

## 2. Cú pháp trong Codex

Skill của hai dự án vẫn hiển thị cú pháp `/graphify` hoặc `/understand` trong tài liệu upstream. Trong Codex Desktop, gọi skill bằng dấu `$`:

```text
$graphify
$understand
$understand-chat
$understand-dashboard
```

Các command bắt đầu bằng executable `graphify` là CLI PowerShell bình thường:

```powershell
graphify query "profile launch flow"
graphify update .
```

Sau khi mới cài đặt, restart Codex Desktop và terminal để nhận PATH cùng danh sách skill mới.

## 3. Quick start trong 10 phút

### Bước 1: Xác minh cài đặt

Chạy từ root của BrProxies:

```powershell
graphify --version
Test-Path .codex\skills\graphify\SKILL.md
Test-Path .codex\skills\understand\SKILL.md
Test-Path .codex\understand-anything\understand-anything-plugin\packages\core\dist\index.js
```

Kết quả mong đợi:

- Graphify báo phiên bản `0.9.50` hoặc mới hơn.
- Ba lệnh `Test-Path` trả về `True`.

Nếu `graphify` chưa được nhận diện, restart terminal. Executable hiện được cài dưới thư mục tool của `uv`, còn shim nằm trong `%USERPROFILE%\.local\bin`.

### Bước 2: Loại trừ file không nên index

Trước lần build graph đầu tiên, tạo `.graphifyignore` ở root project:

```gitignore
.git/
.codex/
.claude/
.ua/
.understand-anything/
graphify-out/
node_modules/
dist/
coverage/
src-tauri/target/
target-codex-check/
proxypool_service/.venv/
android_manager/.venv/
logs/
*.log
.env
.env.*
```

Mục đích quan trọng nhất là tránh index source đã vendor của Understand Anything trong `.codex/understand-anything/`, generated graph của công cụ còn lại, dependency và build artifact.

Trong lần đầu chạy `$understand`, skill sẽ tạo starter ignore tại `.ua/.understandignore` và có thể yêu cầu review trước khi tiếp tục. Bảo đảm file này có các nhóm tương đương:

```gitignore
.git/
.codex/
.claude/
graphify-out/
node_modules/
dist/
coverage/
src-tauri/target/
target-codex-check/
proxypool_service/.venv/
android_manager/.venv/
logs/
*.log
.env
.env.*
```

Không index dữ liệu profile Chromium, cookie database, secret vault, token, kết quả Account Keeper hoặc thư mục runtime trong `%APPDATA%`.

### Bước 3: Khởi tạo Graphify ở chế độ tiết kiệm

Lần đầu nên tạo code graph deterministic, không phân tích tài liệu bằng LLM:

```powershell
graphify extract . --code-only --cargo
```

Kết quả nằm trong `graphify-out/`, quan trọng nhất là:

```text
graphify-out/graph.json
graphify-out/graph.html
graphify-out/GRAPH_REPORT.md
```

Sau đó thử ba truy vấn:

```powershell
graphify query "How does the React frontend invoke Tauri commands?" --budget 2000
graphify path "App" "launch_profile"
graphify affected "settings.rs" --depth 2
```

Nếu cần graph bao gồm Markdown, OpenAPI hoặc tài liệu khác, gọi `$graphify .` trong Codex ở một phiên riêng. Semantic extraction có thể dùng model và token, vì vậy không nên bật mặc định cho mọi lần update.

### Bước 4: Khởi tạo Understand Anything

Trong Codex Desktop:

```text
$understand . --language vi --exclude ".codex/**,.claude/**,graphify-out/**,src-tauri/target/**,node_modules/**,dist/**"
```

Lần đầu là full analysis. Những lần gọi `$understand` sau mặc định là incremental và chỉ phân tích phần thay đổi.

Khi hoàn thành, graph chính nằm tại:

```text
.ua/knowledge-graph.json
```

Mở dashboard:

```text
$understand-dashboard
```

## 4. Chọn công cụ theo nhu cầu

| Nhu cầu | Dùng trước | Dùng bổ sung |
| --- | --- | --- |
| Tìm file hoặc symbol liên quan | `graphify query` | `$understand-chat` |
| Theo dõi đường gọi giữa hai subsystem | `graphify path` | `$understand-explain` |
| Ước lượng phạm vi ảnh hưởng | `graphify affected` | `$understand-diff` |
| Hiểu sâu một file/function | `graphify explain` | `$understand-explain` |
| Sửa bug nhỏ | Graphify | Understand Diff sau khi sửa |
| Feature xuyên frontend/Rust/Python | Graphify query + path | Understand Chat/Domain |
| Refactor lớn | Graphify affected | Understand Diff + Dashboard |
| Review pull request | Graphify affected | `$understand-diff` |
| Onboarding developer mới | Graphify report | `$understand-onboard` + dashboard |
| Giải thích cho PM hoặc stakeholder | Graphify để xác minh | `$understand-domain` |
| Phân tích knowledge base | Không bắt buộc | `$understand-knowledge` |
| Liên kết code với Figma | Graphify cho code | `$understand-figma` |

### Khi chỉ cần Graphify

- Câu hỏi là “file nào gọi file nào?”.
- Cần shortest path, reverse impact hoặc danh sách hub.
- Đang tối ưu token và không cần narrative dài.
- Cần cập nhật graph sau một thay đổi code nhỏ.
- Cần bằng chứng `EXTRACTED`, `INFERRED` hoặc `AMBIGUOUS` trên edge.

### Khi cần Understand Anything

- Thành viên mới cần một lộ trình học codebase.
- Muốn xem kiến trúc bằng dashboard.
- Cần mô tả business flow thay vì chỉ call graph.
- Cần giải thích theo ngôn ngữ tự nhiên cho PM hoặc non-Rust developer.
- Cần phân tích git diff/PR và hiển thị overlay ảnh hưởng.

## 5. Golden workflow cho công việc hằng ngày

### Trước khi sửa code

1. Chuyển đến root project.
2. Kiểm tra graph có tồn tại và còn tương đối mới.
3. Dùng Graphify khoanh vùng subsystem.
4. Đọc source của các node quan trọng.
5. Chỉ dùng Understand Anything nếu cần narrative hoặc domain context.

Ví dụ:

```powershell
graphify query "Where is proxy assignment validated before browser launch?" --budget 1800
graphify path "proxy.rs" "launch.rs"
graphify affected "ProxyConfig" --depth 3
```

Sau đó có thể hỏi:

```text
$understand-explain src-tauri/src/launch.rs
```

### Trong khi sửa code

- Dùng source và test làm nguồn sự thật, không sửa chỉ dựa trên summary của graph.
- Nếu thay đổi qua nhiều boundary, giữ các lớp đồng bộ:
  - React state/type/handler.
  - Tauri command và `invoke_handler!`.
  - Rust store/settings/API schema.
  - Python service hoặc SDK nếu contract thay đổi.
- Không rebuild graph giữa từng edit nhỏ.

### Sau khi sửa code

Chạy test/build phù hợp trước:

```powershell
# UI hoặc TypeScript
npm.cmd run build

# ProxyPool
python -m pytest proxypool_service\tests -q

# Cross-boundary UI + ProxyPool
python -m pytest proxypool_service\tests -q
npm.cmd run build
```

Cập nhật graph kỹ thuật:

```powershell
graphify update .
```

Lệnh trên chỉ re-extract code bằng AST. Nếu thay đổi Markdown, OpenAPI, PDF hoặc nội dung semantic khác đang được đưa vào graph, dùng skill incremental để chỉ phân tích lại các tài liệu đã đổi:

```text
$graphify . --update
```

Phân tích thay đổi bằng graph ngữ nghĩa:

```text
$understand-diff
```

Chỉ chạy lại `$understand` khi graph báo stale, thay đổi kiến trúc đáng kể hoặc cần dashboard cập nhật đầy đủ.

## 6. Workflow theo tình huống

### 6.1 Sửa bug

```text
1. graphify query: tìm subsystem và symbol liên quan.
2. graphify path: xác nhận đường truyền dữ liệu/call.
3. graphify affected: tìm caller và downstream risk.
4. Đọc source + tái hiện bug.
5. Sửa tối thiểu và chạy focused test.
6. graphify update .
7. $understand-diff để kiểm tra ảnh hưởng ngoài dự kiến.
```

Prompt mẫu cho lỗi ProxyPool:

```powershell
graphify query "Why can ProxyPool report connected but UI still shows Unknown?" --budget 2500
graphify path "proxypool.rs" "App.tsx"
graphify affected "POST /jobs/check" --depth 3
```

### 6.2 Phát triển feature xuyên nhiều lớp

Trước khi thiết kế:

```powershell
graphify query "How are persistent launcher settings represented from React to Rust storage?"
graphify path "App.tsx" "settings.rs"
graphify affected "AppSettings" --depth 3
```

Khi cần business context:

```text
$understand-chat Mô tả toàn bộ lifecycle của một browser profile từ lúc tạo đến lúc Chromium khởi chạy.
$understand-domain
```

Sau khi implement:

```powershell
graphify update .
```

```text
$understand-diff
```

### 6.3 Refactor

Graphify là bước bắt buộc trước refactor vì tên file hoặc class không phản ánh hết coupling:

```powershell
graphify affected "Profile" --relation calls --relation imports --depth 4
graphify god-nodes --top 20
graphify path "profile.rs" "api.rs"
```

Sau refactor có xóa nhiều code, `graphify update .` có shrink guard để tránh ghi đè graph khi kết quả bất thường. Chỉ dùng `--force` sau khi đã xác nhận việc giảm node là hợp lệ:

```powershell
graphify update . --force
```

Tiếp theo chạy `$understand-diff` để tìm component, layer và tour bị ảnh hưởng.

### 6.4 Review pull request hoặc branch

```text
$understand-diff
```

Skill sẽ đọc git diff, đối chiếu node/layer trong `.ua/knowledge-graph.json` và tạo `.ua/diff-overlay.json` cho dashboard.

Sau đó dùng Graphify kiểm tra một thay đổi cụ thể:

```powershell
graphify affected "TênSymbolThayĐổi" --depth 3
graphify path "NodeNguồn" "NodeĐích"
```

Review nên kết thúc bằng source diff và test output, không kết thúc bằng graph summary.

### 6.5 Onboarding thành viên mới

1. Refresh graph trước buổi onboarding:

```powershell
graphify update .
```

```text
$understand
$understand-onboard
$understand-dashboard
```

2. Dùng `graphify-out/GRAPH_REPORT.md` để giới thiệu subsystem và god nodes.
3. Dùng dashboard để đi theo guided tour.
4. Cho thành viên mới tự dùng `$understand-explain` với một file thuộc task đầu tiên.
5. Khi skill hỏi có lưu guide không, lưu vào `docs/UA_ONBOARDING.md` nếu team muốn duy trì tài liệu onboarding riêng.

### 6.6 Architecture review

```powershell
graphify god-nodes --top 20
graphify query "What are the architectural boundaries of BrProxies?" --budget 3000
graphify export callflow-html
```

```text
$understand-domain
$understand-dashboard
```

Graphify giúp tìm coupling/hub; Understand Anything giúp chuyển kết quả thành layer, flow và narrative dễ trình bày.

## 7. Prompt mẫu riêng cho BrProxies

### Browser profile và runtime

```powershell
graphify query "Trace profile creation, persistence, and launch across frontend and Rust"
graphify path "create_profile" "launch_profile"
graphify affected "BrowserProfile" --depth 3
```

```text
$understand-chat Giải thích lifecycle của browser profile, gồm store, fingerprint, proxy, user-data-dir và process tracking.
```

### Cookie encryption

```powershell
graphify query "How does cookie import differ between Windows and macOS/Linux?"
graphify path "cookies.rs" "Local State"
```

```text
$understand-explain src-tauri/src/cookies.rs
```

### Proxy và UDP

```powershell
graphify query "Where are HTTP and SOCKS5 proxies parsed, tested, geo-resolved, and assigned?"
graphify affected "udp_probe" --depth 3
graphify path "proxy.rs" "launch.rs"
```

### MCP và Automation API

```powershell
graphify query "Trace an MCP profile-start request through the local HTTP API to Chromium launch"
graphify path "mcp" "launch.rs"
graphify affected "POST /profiles/{id}/start" --depth 4
```

```text
$understand-chat So sánh vai trò của MCP server, HTTP API, CDP handoff và Tauri backend.
```

### ProxyPool sidecar

```powershell
graphify query "Trace Collect now and Refresh from React through Tauri to the Python ProxyPool API"
graphify path "App.tsx" "scheduler.py"
graphify affected "POST /jobs/collect" --depth 4
```

### SDK contract

```powershell
graphify query "Which Python and Node SDK methods depend on the profile start API contract?"
graphify affected "openapi.yaml" --depth 4
```

```text
$understand-diff
```

## 8. Tối ưu token và tốc độ

### Graphify

- Dùng `graphify extract . --code-only` cho lần khởi tạo rẻ nhất.
- Dùng `graphify update .` sau thay đổi code; không chạy full extract lại.
- Giới hạn output truy vấn bằng `--budget`:

```powershell
graphify query "authentication flow" --budget 1500
```

- Dùng `path` khi đã biết hai endpoint; đừng query rộng.
- Dùng `affected` trước refactor hoặc PR review.
- Dùng `cluster-only` khi chỉ muốn cập nhật community/report từ graph hiện có:

```powershell
graphify cluster-only . --no-viz
```

### Understand Anything

- Lần đầu mới dùng full analysis.
- Mặc định gọi `$understand` không có `--full`; incremental đủ cho phần lớn trường hợp.
- Có thể gọi `$understand . --auto-update` một lần để bật cập nhật sau commit. Chỉ bật khi team chấp nhận chi phí và thời gian hook; tắt bằng `$understand . --no-auto-update`.
- Chỉ dùng `--full` sau refactor lớn, thay đổi ignore rules hoặc graph hỏng.
- Chỉ dùng `--review` khi cần LLM reviewer đầy đủ trước milestone/release.
- Với câu hỏi đơn lẻ, dùng `$understand-chat` hoặc `$understand-explain`, không rebuild graph.
- Với code vừa thay đổi, ưu tiên `$understand-diff`.

### Tránh anti-pattern

- Không chạy `$graphify` full và `$understand --full` liên tiếp cho một bug nhỏ.
- Không đọc toàn bộ `graph.json` hoặc `knowledge-graph.json` vào context.
- Không dùng dashboard như bằng chứng cuối cùng về runtime behavior.
- Không chạy semantic analysis trên dependency, build output hoặc secret-bearing data.

## 9. Privacy và dữ liệu nhạy cảm

### Graphify

`--code-only` dùng AST local và không cần API key. Khi phân tích docs, PDF, ảnh hoặc media, semantic backend có thể nhận nội dung tùy cấu hình provider.

### Understand Anything

Pipeline sử dụng coding agent/model để tạo summary và quan hệ ngữ nghĩa. Nội dung có thể đi qua provider đang cấu hình cho Codex. Với repo hoặc dữ liệu nhạy cảm:

- Dùng provider local nếu có.
- Loại trừ `.env`, token, credential, browser profile data và vault.
- Không phân tích `%APPDATA%\brproxies-launcher\`.
- Không đưa `account-keeper-result.json`, `account-keeper-input.txt` hoặc secret-bearing logs vào graph.
- Review generated graph trước khi chia sẻ ra ngoài team.
- `$understand-figma` thực hiện outbound request tới `api.figma.com`; chỉ truyền token qua biến môi trường và không ghi token vào graph hoặc log.

## 10. Chính sách cập nhật và chia sẻ graph

Khuyến nghị mặc định cho BrProxies:

- Giữ `graphify-out/` và `.ua/` local nếu team chưa thống nhất cách chia sẻ.
- Commit skill/config cài đặt trong `.codex/` nếu muốn mọi người có cùng workflow.
- Chỉ commit generated graph khi có mục tiêu rõ ràng như onboarding snapshot hoặc architecture review.
- Không commit cache, intermediate file, access token URL hoặc dữ liệu có thể chứa secret.

Nhịp vận hành đề xuất:

| Thời điểm | Hành động |
| --- | --- |
| Sau một thay đổi code nhỏ | `graphify update .` |
| Trước khi mở PR | `graphify update .` + `$understand-diff` |
| Sau thay đổi kiến trúc | `$understand` incremental + dashboard |
| Trước milestone/release | `$understand --review` nếu ngân sách cho phép |
| Onboarding thành viên mới | Refresh cả hai graph, sau đó `$understand-onboard` |

## 11. Cheat sheet

### Graphify CLI và skill

| Command | Dùng khi |
| --- | --- |
| `graphify extract . --code-only --cargo` | Khởi tạo graph local cho BrProxies |
| `graphify query "..." --budget 2000` | Tìm context liên quan một câu hỏi |
| `graphify path "A" "B"` | Tìm đường ngắn nhất giữa hai node |
| `graphify explain "X"` | Giải thích node và hàng xóm |
| `graphify affected "X" --depth 3` | Tìm phạm vi ảnh hưởng ngược |
| `graphify god-nodes --top 20` | Tìm architectural hubs |
| `graphify update .` | Cập nhật AST sau thay đổi code |
| `graphify update . --force` | Chấp nhận graph nhỏ hơn sau refactor đã xác minh |
| `graphify cluster-only . --no-viz` | Recluster graph hiện có |
| `graphify watch .` | Theo dõi liên tục trong terminal riêng; dừng bằng `Ctrl+C` |
| `graphify export callflow-html` | Tạo architecture/call-flow HTML |
| `$graphify . --graphml` | Build/update qua skill và export cho Gephi/yEd |
| `graphify benchmark graphify-out/graph.json` | Đo token reduction |

### Understand Anything skills

| Skill Codex | Dùng khi |
| --- | --- |
| `$understand` | Build hoặc incremental update knowledge graph |
| `$understand . --full` | Full rebuild có chủ đích |
| `$understand . --language vi` | Tạo summary/dashboard tiếng Việt |
| `$understand . --auto-update` | Bật incremental update sau commit |
| `$understand . --no-auto-update` | Tắt auto-update hook |
| `$understand-chat <câu hỏi>` | Hỏi graph bằng ngôn ngữ tự nhiên |
| `$understand-explain <file hoặc symbol>` | Deep dive một thành phần |
| `$understand-diff` | Phân tích working tree, branch hoặc PR |
| `$understand-domain` | Tạo business domain/flow graph |
| `$understand-dashboard` | Mở dashboard tương tác |
| `$understand-onboard` | Tạo onboarding guide |
| `$understand-knowledge <thư mục>` | Phân tích knowledge base/wiki |
| `$understand-figma <URL hoặc key>` | Tạo design graph từ Figma |

## 12. Troubleshooting

### `graphify` không được nhận diện

1. Restart Codex Desktop và PowerShell.
2. Kiểm tra:

```powershell
Test-Path $HOME\.local\bin\graphify.exe
[Environment]::GetEnvironmentVariable('Path', 'User')
```

3. Có thể chạy trực tiếp executable đã cài:

```powershell
& "$env:APPDATA\uv\tools\graphifyy\Scripts\graphify.exe" --version
```

### Graphify báo không tìm thấy `graph.json`

Graph chưa được khởi tạo hoặc command đang chạy sai working directory:

```powershell
graphify extract . --code-only --cargo
Test-Path graphify-out\graph.json
```

### Graphify graph stale

```powershell
graphify update .
```

Sau refactor xóa nhiều code, kiểm tra output trước khi dùng `--force`.

### `$understand-chat` hoặc `$understand-explain` yêu cầu chạy `$understand`

Kiểm tra graph:

```powershell
Test-Path .ua\knowledge-graph.json
Test-Path .understand-anything\knowledge-graph.json
```

Nếu cả hai là `False`, chạy `$understand` trước.

### Understand Anything không tìm thấy plugin root

Kiểm tra project-local runtime:

```powershell
Test-Path .codex\understand-anything\understand-anything-plugin\package.json
Test-Path .codex\understand-anything\understand-anything-plugin\packages\core\dist\index.js
```

Nếu core chưa build:

```powershell
cd .codex\understand-anything\understand-anything-plugin
pnpm.cmd install --frozen-lockfile
pnpm.cmd -r build
cd ..\..\..
```

### Dashboard không mở

1. Xác nhận `.ua/knowledge-graph.json` tồn tại.
2. Gọi lại `$understand-dashboard`.
3. Kiểm tra firewall hoặc port localhost.
4. Nếu release viewer không tồn tại cho version đang dùng, skill sẽ fallback sang dashboard build local.

### Graph chứa file `.codex` hoặc generated output

1. Cập nhật `.graphifyignore` và `.ua/.understandignore`.
2. Rebuild có chủ đích:

```powershell
graphify extract . --code-only --cargo --force
```

```text
$understand . --full --language vi
```

## 13. Checklist vận hành team

### Trước task

- [ ] Graph hiện có và không quá stale.
- [ ] Đã query/path/affected để khoanh vùng.
- [ ] Đã xác minh source code quan trọng.
- [ ] Ignore rules không index dependency, generated output hoặc secret.

### Trước PR

- [ ] Focused tests/build đã pass.
- [ ] `graphify update .` đã chạy.
- [ ] `$understand-diff` đã kiểm tra ảnh hưởng.
- [ ] API/OpenAPI/SDK được cập nhật đồng bộ nếu contract đổi.
- [ ] Không có graph artifact nhạy cảm bị stage ngoài ý muốn.

### Trước onboarding hoặc architecture review

- [ ] Graphify graph đã refresh.
- [ ] Understand Anything graph đã incremental update.
- [ ] Dashboard mở được.
- [ ] Guided tour/onboarding guide không dựa trên graph stale.
- [ ] Nội dung chia sẻ đã được review privacy.

## 14. Tóm tắt một dòng

> Dùng **Graphify để biết chính xác các thành phần kết nối thế nào**, dùng **Understand Anything để giải thích và trình bày vì sao chúng quan trọng**, rồi luôn xác minh bằng source và test trước khi thay đổi code.
