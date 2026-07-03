# Android Manager

Android Manager controls ReDroid containers on a Linux host for BrProxies.

## Supported MVP Topology

- BrProxies may run on Windows, macOS, or Linux.
- ReDroid containers run on Ubuntu 22.04/24.04 Linux host.
- Windows development can use a fake manager or remote Ubuntu host.
- Windows-native ReDroid is not required for MVP.

## Linux Host Packages

```bash
sudo apt update
sudo apt install -y docker.io adb scrcpy python3 python3-venv python3-pip curl git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and back in after `usermod`.

## Kernel Devices

```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux || true
ls /dev/binder /dev/hwbinder /dev/vndbinder
```

## Validator

```bash
bash scripts/android-host-validator.sh
```

The validator must pass before building the UI against real ReDroid.

## MVP Limits

- ReDroid requires Linux binder devices; Windows-native runtime is not part of MVP.
- Android global HTTP proxy is best effort and does not force all app traffic.
- `scrcpy` opens a native window; browser-embedded streaming is a later phase.
- APK compatibility must be validated with target apps, especially ARM-only or Google Play Services apps.
- ADB ports must stay bound to localhost/private networks.
