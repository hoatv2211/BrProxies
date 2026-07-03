# Android Manager

Android Manager controls Android instances for BrProxies. On Windows it can run real Android Emulator/AVD instances. On Linux it can run ReDroid containers when binder devices are available.

## Supported MVP Topology

- BrProxies may run on Windows, macOS, or Linux.
- Windows real runtime uses Android Emulator/AVD plus ADB and scrcpy.
- ReDroid containers run on Ubuntu 22.04/24.04 Linux host.
- Fake runtime is only for UI/API debugging and does not open a real Android screen.
- Windows-native ReDroid is not supported.

## Windows AVD Runtime

Install Android Studio or Android Command Line Tools, then make these commands available on `PATH`:

```powershell
adb version
emulator -version
avdmanager list avd
scrcpy --version
```

In BrProxies Settings, set Android Manager runtime to `Windows AVD (real local emulator)`. Press `Start manager`, create an Android instance, then press `Start`. The manager creates an AVD, starts `emulator.exe`, waits for ADB boot, and opens `scrcpy`.

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
