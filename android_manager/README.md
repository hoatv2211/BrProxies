# BrProxies Android Manager

Android Manager is a local FastAPI sidecar used by BrProxies to create, start,
stop, and inspect Android instances.

Current focus is real Android Studio AVD on Windows. ReDroid remains a later
Linux-host option. Fake runtime is only for UI/API debugging and should not be
used when you expect a real Android screen.

## Runtime Status

| Runtime | Status | Notes |
| ------- | ------ | ----- |
| `windows_avd` | Current local path | Real Android Emulator/AVD on Windows. Uses ADB and scrcpy. |
| `external_adb` | Planned | Attach/import LDPlayer, BlueStacks, MEmu, or other ADB devices. |
| `redroid` | Planned for Linux | Needs Linux binder devices. Not Windows-native. |
| `fake` | Debug only | Creates API rows but does not open Android. |

## Windows AVD Setup

Install Android Studio, then use SDK Manager to install:

- Android SDK Platform Tools
- Android Emulator
- Android SDK Command-line Tools
- `system-images;android-35;google_apis;x86_64`

The `google_apis` image is preferred for BrProxies because it is lighter and has
fewer bundled apps than the Play Store image. Use Play Store only when target
apps need it.

PowerShell install command:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$env:LOCALAPPDATA\Android\Sdk" "system-images;android-35;google_apis;x86_64"
```

Install scrcpy for the native control window:

```powershell
winget install Genymobile.scrcpy
```

Restart PowerShell after installing scrcpy if the `scrcpy` command is not found.

## Verify Tools

```powershell
adb version
emulator -version
avdmanager list avd
scrcpy --version
```

If commands are not found, add these folders to `PATH` or configure them in
BrProxies Settings:

```text
%LOCALAPPDATA%\Android\Sdk\platform-tools
%LOCALAPPDATA%\Android\Sdk\emulator
%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin
```

## App Flow

1. Open BrProxies > **Android**.
2. Click **Start manager**. This starts the Python sidecar only.
3. Click **Create device**. The sidecar creates a BrProxies-managed AVD.
4. Click **Start**. The sidecar boots `emulator.exe`, waits for Android boot,
   then opens `scrcpy` when available.
5. Click **Import devices** only when you already have running devices visible in
   `adb devices -l`.

`Import devices` imports running ADB devices only. It does not import stopped AVD
definitions from `avdmanager list avd`. This avoids filling the app with devices
that cannot currently be controlled.

## Direct Commands

List AVD definitions:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\avdmanager.bat" list avd
```

List running ADB devices:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices -l
```

Start an AVD manually for debugging:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd <AVD_NAME> -no-snapshot-load
```

Open screen manually:

```powershell
scrcpy -s emulator-5554 --max-size 1280 --video-bit-rate 8M --stay-awake
```

## Performance Notes

- Cold boot often takes 30-70 seconds. Quick Boot snapshots make later starts
  faster.
- Hardware acceleration must be enabled for acceptable speed.
- `google_apis;x86_64` is lighter than `google_apis_playstore;x86_64`.
- AVD is good for clean Android testing and light apps. LDPlayer-like gaming
  smoothness needs a later `external_adb` path or direct emulator use.
- Some games detect emulators or require ARM translation/Play Services and may
  not run well on standard AVD.

## Troubleshooting

### No Android x86_64 system image is installed

Install the preferred image:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$env:LOCALAPPDATA\Android\Sdk" "system-images;android-35;google_apis;x86_64"
```

### Unknown AVD name

The AVD row exists in BrProxies but the AVD definition is missing from Android
SDK storage. Run:

```powershell
avdmanager list avd
```

Then delete the stale row in BrProxies or recreate the device.

### App says stopped while emulator window is open

Status is based on ADB visibility. Check:

```powershell
adb devices -l
```

If no device appears, restart ADB:

```powershell
adb kill-server
adb start-server
adb devices -l
```

### scrcpy opens but control is laggy

Try a smaller window and lower bitrate:

```powershell
scrcpy -s emulator-5554 --max-size 960 --video-bit-rate 4M --max-fps 30
```

Also close unused emulators and enable hardware acceleration in Android Studio.

## ReDroid Notes

ReDroid runs Android in Docker on a Linux host with binder devices:

```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux || true
ls /dev/binder /dev/hwbinder /dev/vndbinder
```

Windows-native ReDroid is not supported. WSL2 does not provide the same simple
Android device experience as a real Linux host for this use case.
