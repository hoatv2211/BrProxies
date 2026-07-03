# Kế hoạch triển khai Android Cloud Phone Platform giống PhoneGrid

## 1. Mục tiêu

Xây dựng nền tảng tự host cho phép tạo, chạy, quản lý nhiều Android instances giống LDPlayer multi-instance nhưng nhẹ hơn, dùng container thay vì emulator nặng.

MVP cần có:

- Tạo Android instance
- Start/stop/delete instance
- Mỗi instance có ADB port riêng
- Cài APK vào instance
- Mở màn hình instance bằng scrcpy
- Gắn proxy cơ bản
- Dashboard quản lý instances
- API backend để thao tác tự động

Không thuộc MVP:

- Billing
- Team permission phức tạp
- Marketplace app
- RPA kéo thả
- Anti-detect nâng cao
- WebRTC streaming production-grade

---

## 2. Stack đề xuất

```text
OS: Ubuntu 22.04 LTS hoặc Ubuntu 24.04 LTS
Runtime: Docker
Android runtime: ReDroid
Device control: ADB
Screen control: scrcpy
Backend: FastAPI
Frontend: React + Vite
Database: SQLite cho MVP, PostgreSQL cho production
Automation: uiautomator2
Queue: Redis + RQ/Celery nếu cần chạy task nền
Proxy: Android global proxy cho MVP, Docker network proxy cho production
```

Lý do chọn ReDroid:

- Android chạy trong container
- Nhẹ hơn emulator/QEMU
- Dễ tạo nhiều instances
- Dễ quản lý bằng Docker
- Dùng được ADB/scrcpy/uiautomator2

---

## 3. Kiến trúc tổng quan

```text
User Browser
   |
React Dashboard
   |
FastAPI Backend
   |
Instance Manager
   |
Docker Engine
   |
ReDroid Containers
   |
ADB / scrcpy / uiautomator2
```

Mỗi Android instance = 1 Docker container:

```text
redroid-001 -> port 5555 -> volume redroid_001_data
redroid-002 -> port 5556 -> volume redroid_002_data
redroid-003 -> port 5557 -> volume redroid_003_data
```

---

## 4. Cấu trúc repo đề xuất

```text
android-cloud-phone/
├── README.md
├── docker-compose.yml
├── .env.example
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── deployment.md
│   └── troubleshooting.md
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── routers/
│   │   │   ├── instances.py
│   │   │   ├── apk.py
│   │   │   ├── proxy.py
│   │   │   └── automation.py
│   │   ├── services/
│   │   │   ├── docker_service.py
│   │   │   ├── adb_service.py
│   │   │   ├── scrcpy_service.py
│   │   │   ├── proxy_service.py
│   │   │   └── instance_service.py
│   │   └── utils/
│   │       └── ports.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/
│       │   └── client.ts
│       ├── pages/
│       │   ├── InstancesPage.tsx
│       │   └── InstanceDetailPage.tsx
│       └── components/
│           ├── InstanceTable.tsx
│           ├── CreateInstanceModal.tsx
│           └── ApkUpload.tsx
├── scripts/
│   ├── install-host.sh
│   ├── load-kernel-modules.sh
│   ├── create-instance.sh
│   ├── clone-instance.sh
│   └── install-apk-all.sh
└── examples/
    ├── uiautomator2-demo.py
    └── sample-proxy.json
```

---

## 5. Host setup

### 5.1. Cài packages

```bash
sudo apt update
sudo apt install -y docker.io adb scrcpy python3 python3-pip python3-venv curl git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Đăng xuất/đăng nhập lại sau `usermod`.

### 5.2. Load kernel modules

```bash
sudo apt install -y linux-modules-extra-$(uname -r)
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux || true
```

Kiểm tra:

```bash
ls /dev/binderfs || true
ls /dev/binder || true
```

Nếu binder chưa có, cần kiểm tra kernel/binderfs support.

---

## 6. ReDroid instance commands

### 6.1. Tạo 1 instance

```bash
docker volume create redroid_001_data

docker run -itd --privileged \
  --name redroid-001 \
  -v redroid_001_data:/data \
  -p 5555:5555 \
  redroid/redroid:12.0.0-latest
```

### 6.2. Kết nối ADB

```bash
adb connect localhost:5555
adb devices
```

### 6.3. Mở màn hình

```bash
scrcpy -s localhost:5555
```

### 6.4. Stop instance

```bash
docker stop redroid-001
```

### 6.5. Start instance

```bash
docker start redroid-001
adb connect localhost:5555
```

### 6.6. Delete instance

```bash
docker rm -f redroid-001
docker volume rm redroid_001_data
```

---

## 7. Data model MVP

### 7.1. Instance

```text
id: string
name: string
container_name: string
adb_host: string
adb_port: int
volume_name: string
image: string
status: created | running | stopped | error
proxy_id: nullable string
created_at: datetime
updated_at: datetime
```

### 7.2. Proxy

```text
id: string
name: string
type: http | socks5
host: string
port: int
username: nullable string
password: nullable string
status: unchecked | valid | invalid
created_at: datetime
updated_at: datetime
```

### 7.3. APK

```text
id: string
filename: string
path: string
package_name: nullable string
uploaded_at: datetime
```

---

## 8. API MVP

### 8.1. Instance APIs

```text
GET    /api/instances
POST   /api/instances
GET    /api/instances/{id}
POST   /api/instances/{id}/start
POST   /api/instances/{id}/stop
DELETE /api/instances/{id}
POST   /api/instances/{id}/connect-adb
POST   /api/instances/{id}/open-screen
POST   /api/instances/{id}/install-apk
POST   /api/instances/{id}/set-proxy
POST   /api/instances/{id}/clear-proxy
GET    /api/instances/{id}/screenshot
```

### 8.2. Proxy APIs

```text
GET    /api/proxies
POST   /api/proxies
POST   /api/proxies/{id}/test
DELETE /api/proxies/{id}
```

### 8.3. APK APIs

```text
GET  /api/apks
POST /api/apks/upload
```

---

## 9. Backend service logic

### 9.1. Create instance

Steps:

1. Allocate free ADB port từ range `5555-5999`
2. Create Docker volume `redroid_{id}_data`
3. Run ReDroid container với mapped port
4. Save DB record
5. Wait vài giây
6. Run `adb connect localhost:{port}`
7. Return instance info

Docker command template:

```bash
docker run -itd --privileged \
  --name {container_name} \
  -v {volume_name}:/data \
  -p {adb_port}:5555 \
  {image}
```

### 9.2. Start instance

```bash
docker start {container_name}
adb connect localhost:{adb_port}
```

### 9.3. Stop instance

```bash
docker stop {container_name}
```

### 9.4. Delete instance

```bash
docker rm -f {container_name}
docker volume rm {volume_name}
```

### 9.5. Install APK

```bash
adb -s localhost:{adb_port} install -r {apk_path}
```

### 9.6. Screenshot

```bash
adb -s localhost:{adb_port} exec-out screencap -p > screenshot.png
```

### 9.7. Open screen

Local dev only:

```bash
scrcpy -s localhost:{adb_port}
```

Production web screen cần thiết kế riêng: WebRTC, noVNC, hoặc scrcpy websocket bridge.

---

## 10. Proxy MVP

### 10.1. Set Android global HTTP proxy

```bash
adb -s localhost:{adb_port} shell settings put global http_proxy {host}:{port}
```

### 10.2. Clear proxy

```bash
adb -s localhost:{adb_port} shell settings put global http_proxy :0
```

### 10.3. Proxy limitation

Android global HTTP proxy không bắt toàn bộ traffic. Một số app không tôn trọng setting này.

Production cần một trong các hướng:

- VPN app trong Android
- iptables/tproxy ở Docker host
- sidecar proxy per instance
- dedicated network namespace per instance

---

## 11. Frontend MVP

### 11.1. Instances page

Columns:

```text
Name
Status
ADB Port
Proxy
Image
Created At
Actions
```

Actions:

```text
Start
Stop
Open Screen
Install APK
Set Proxy
Screenshot
Delete
```

### 11.2. Create instance modal

Fields:

```text
Name
Android image
ADB port auto/manual
Proxy optional
```

### 11.3. Instance detail page

Show:

```text
Basic info
Container status
ADB status
Proxy status
Installed APK actions
Latest screenshot
Logs
```

---

## 12. Automation MVP

Dùng `uiautomator2`.

Install:

```bash
pip install -U uiautomator2
```

Example:

```python
import uiautomator2 as u2

d = u2.connect("localhost:5555")
d.app_start("com.android.settings")
d.screenshot("screen.png")
```

API sau này:

```text
POST /api/instances/{id}/automation/run
```

Request:

```json
{
  "script": "open_settings.py",
  "args": {}
}
```

---

## 13. Clone instance

### 13.1. Stop source trước khi clone

```bash
docker stop redroid-001
```

### 13.2. Copy volume

```bash
docker volume create redroid_002_data

docker run --rm \
  -v redroid_001_data:/from \
  -v redroid_002_data:/to \
  alpine sh -c "cd /from && cp -a . /to"
```

### 13.3. Start clone

```bash
docker run -itd --privileged \
  --name redroid-002 \
  -v redroid_002_data:/data \
  -p 5556:5555 \
  redroid/redroid:12.0.0-latest
```

---

## 14. Resource control

MVP có thể thêm Docker limits:

```bash
--cpus="1.0" --memory="1536m"
```

Command:

```bash
docker run -itd --privileged \
  --cpus="1.0" \
  --memory="1536m" \
  --name redroid-001 \
  -v redroid_001_data:/data \
  -p 5555:5555 \
  redroid/redroid:12.0.0-latest
```

Ước lượng:

```text
Idle instance: 500MB-1.5GB RAM
App nhẹ: 1GB-2GB RAM
App nặng: 2GB-3GB+ RAM
```

---

## 15. Security notes

- Không expose ADB port ra internet public.
- Bind ADB vào localhost hoặc private network.
- Dashboard cần auth trước khi deploy public.
- APK upload cần kiểm tra path traversal.
- Không log proxy password dạng plaintext.
- Docker privileged có rủi ro cao; production cần hardening.
- User scripts automation không chạy trực tiếp nếu chưa sandbox.

---

## 16. Milestones

### Milestone 1: Manual ReDroid proof-of-concept

Done khi:

- Host chạy được ReDroid
- ADB connect được
- scrcpy mở được màn hình
- Cài APK được
- Chạy 2-3 instances song song được

### Milestone 2: Backend API

Done khi:

- `POST /instances` tạo container
- `GET /instances` list containers
- start/stop/delete chạy ổn
- install APK chạy ổn
- screenshot chạy ổn

### Milestone 3: Dashboard

Done khi:

- UI list instances
- create/start/stop/delete từ UI
- upload/install APK từ UI
- xem screenshot từ UI

### Milestone 4: Proxy manager

Done khi:

- CRUD proxy
- test proxy cơ bản
- assign proxy vào instance
- clear proxy

### Milestone 5: Automation

Done khi:

- chạy uiautomator2 script qua API
- lưu logs
- lưu screenshot output

### Milestone 6: Production hardening

Done khi:

- auth
- resource limits
- monitoring
- error handling
- database migration
- backup volume
- private networking

---

## 17. Commands quick test

```bash
# create
docker volume create redroid_test_data

docker run -itd --privileged \
  --name redroid-test \
  -v redroid_test_data:/data \
  -p 5555:5555 \
  redroid/redroid:12.0.0-latest

# adb
adb connect localhost:5555
adb devices

# screen
scrcpy -s localhost:5555

# install apk
adb -s localhost:5555 install -r ./app.apk

# screenshot
adb -s localhost:5555 exec-out screencap -p > screenshot.png

# stop
docker stop redroid-test

# start
docker start redroid-test
adb connect localhost:5555

# delete
docker rm -f redroid-test
docker volume rm redroid_test_data
```

---

## 18. Troubleshooting

### ADB không connect

Check container:

```bash
docker ps
```

Check port:

```bash
ss -lntp | grep 5555
```

Reconnect:

```bash
adb kill-server
adb start-server
adb connect localhost:5555
```

### scrcpy đen màn hình

Thử:

```bash
scrcpy -s localhost:5555 --no-audio
```

Check ADB:

```bash
adb -s localhost:5555 shell getprop ro.build.version.release
```

### ReDroid không boot

Check logs:

```bash
docker logs redroid-001 --tail=200
```

Check binder:

```bash
ls /dev/binder /dev/hwbinder /dev/vndbinder 2>/dev/null || true
ls /dev/binderfs 2>/dev/null || true
```

Load modules:

```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux || true
```

### Proxy không tác dụng trong app

Nguyên nhân: app không dùng Android global HTTP proxy.

Giải pháp:

- dùng VPN/proxy app trong Android
- dùng Docker network proxy
- dùng iptables/tproxy trên host

---

## 19. Production roadmap

Sau MVP, nâng cấp:

```text
Kubernetes orchestration
Per-user quota
Auth/RBAC
WebRTC screen streaming
Instance snapshot/restore
Proxy sidecar
Metrics Prometheus/Grafana
Centralized logs
Task queue
Billing module
Team workspace
```

---

## 20. Kết luận

Bản nhẹ nhất giống PhoneGrid nên bắt đầu bằng:

```text
ReDroid + Docker + ADB + scrcpy + FastAPI + React
```

Tập trung MVP trước:

```text
create/start/stop/delete Android instances
ADB connect
scrcpy screen
APK install
basic proxy
simple dashboard
```

Sau khi MVP ổn mới thêm automation, web streaming, proxy nâng cao, auth, billing.
