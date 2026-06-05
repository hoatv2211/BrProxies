# BrProxies

[English](README.md)

BrProxies là launcher cá nhân để quản lý browser profile, proxy,
fingerprint, Automation API cục bộ và ProxyPool cho crawler.


## Tính năng

- **Profiles** - tạo, clone, pin, gắn tag và chạy browser profile riêng biệt.
- **Fingerprints** - chỉnh device, screen, WebGL/WebGPU, locale, timezone,
  WebRTC, media devices và noise settings.
- **Proxies** - thêm proxy HTTP/HTTPS/SOCKS5, test TCP/UDP/geo và bind vào
  profile.
- **ProxyPool** - cào proxy public miễn phí, test proxy sống, lưu vào Redis,
  recheck và thêm sang tab **Proxies**.
- **Automation API** - HTTP API cục bộ trên `127.0.0.1:40325`, dùng Bearer
  token để điều khiển profile từ code.
- **MCP server** - gói MCP để AI client điều khiển profile/CDP.
- **SDKs** - Python và Node SDK trong thư mục `sdks/`.

## Hình ảnh

| Browsers | Fingerprints |
|----------|--------------|
| ![Không gian quản lý browser](docs/screenshots/Browsers.png) | ![Trình chỉnh fingerprint](docs/screenshots/fingerprints.png) |

| Proxies | ProxyPool |
|---------|-----------|
| ![Trình quản lý proxy](docs/screenshots/proxies.png) | ![Không gian ProxyPool](docs/screenshots/proxypool.png) |

## Chạy nhanh trên Windows

Script nằm trong thư mục [`smart launch`](smart%20launch/):

```bat
"smart launch\build.bat"        :: build web assets + desktop app
"smart launch\run.bat"          :: chạy launcher đã build
"smart launch\build-redis.bat"  :: tải Redis Docker image
"smart launch\run-redis.bat"    :: chạy Redis cho ProxyPool
```

Build và chạy:

```bat
"smart launch\build.bat"
"smart launch\run.bat"
```

File exe mặc định:

```text
src-tauri\target\release\brproxies.exe
```

`run.bat` sẽ gọi `cleanup-proxypool.ps1` để tắt Python sidecar ProxyPool cũ
trước khi mở app.

## Build thủ công

```bash
npm install
npm run build
npm run tauri dev
npm run tauri build
```

Trên Windows PowerShell, dùng `npm.cmd` nếu lệnh `npm` bị lỗi.

## Hướng dẫn dự án

Trang giới thiệu và hướng dẫn sử dụng dạng HTML nằm ở [`docs/index.html`](docs/index.html).

## ProxyPool

ProxyPool chạy bằng Python sidecar cục bộ. Service này lấy proxy từ các nguồn
public đang bật, test proxy thật, lưu proxy pass vào Redis và xóa proxy chết khi
recheck.

Chạy Redis nếu muốn lưu pool:

```bat
"smart launch\build-redis.bat"
"smart launch\run-redis.bat"
```

Redis URL mặc định:

```text
redis://:madpool@127.0.0.1:6380/0
```

Nút trong UI:

- **Connect** - start/connect ProxyPool service cục bộ.
- **Collect now** - cào proxy mới và lưu proxy pass.
- **Check now / Refresh** - test lại proxy đang có và tải lại bảng.
- **Copy** - copy proxy sống.
- **Add** - thêm proxy sống vào tab **Proxies**.
- **Delete** - xóa proxy xấu khỏi pool.
- **Add source** - thêm nguồn cào proxy tùy chỉnh.

ProxyPool API:

| Method | Endpoint | Mục đích |
|--------|----------|----------|
| `GET` | `/health` | trạng thái service và Redis |
| `GET` | `/proxy/random?https=false` | lấy ngẫu nhiên 1 proxy sống |
| `GET` | `/proxy/pop?https=false` | lấy và xóa 1 proxy khỏi pool |
| `GET` | `/proxies?https=false` | liệt kê proxy sống |
| `GET` | `/count?https=false` | đếm proxy sống |
| `DELETE` | `/proxy/{host}:{port}` | xóa proxy xấu |
| `GET` | `/sources` | xem nguồn proxy |
| `POST` | `/sources` | thêm nguồn tùy chỉnh |
| `POST` | `/jobs/collect` | đưa job collect vào hàng đợi |
| `POST` | `/jobs/check` | đưa job recheck vào hàng đợi |

Ví dụ:

```bash
curl "http://127.0.0.1:40326/proxy/random?https=false"
```

Nguồn proxy miễn phí rất thất thường. Bảng trống có thể do mạng chặn source,
source đang lỗi, hoặc tất cả proxy đều fail bài test.

## Automation API cục bộ

Launcher có thể mở API cục bộ trên `127.0.0.1:40325`. Bật trong Settings, copy
Bearer token, rồi gọi từ crawler/tool.

Schema: [openapi.yaml](openapi.yaml)

## Cấu trúc repo

```text
src/                  React/Vite UI
src-tauri/src/        Tauri Rust backend
proxypool_service/    Python FastAPI + Redis proxy pool service
sdks/python/          Python SDK
sdks/node/            Node SDK
mcp/                  MCP server package
smart launch/         Windows build/run helpers
```

## License

Launcher source dùng MIT License. Browser runtime được tải/chạy kèm có thể vẫn
theo điều khoản riêng từ upstream gốc.
