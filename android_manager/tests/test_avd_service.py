from android_manager.avd_service import AvdService


class Recorder:
    def __init__(self):
        self.runs = []
        self.popens = []

    def run(self, args, **kwargs):
        self.runs.append((args, kwargs))
        class Result:
            stdout = "1\n"
        return Result()

    def popen(self, args, **kwargs):
        self.popens.append((args, kwargs))
        class Child:
            pass
        return Child()


def test_avd_service_builds_create_start_stop_and_screen_commands(tmp_path):
    rec = Recorder()
    sdk = tmp_path / "Sdk"
    avd_home = tmp_path / "avd"
    image = sdk / "system-images" / "android-35" / "google_apis" / "x86_64"
    image.mkdir(parents=True)
    (image / "package.xml").write_text("", encoding="utf-8")
    service = AvdService(data_dir=str(tmp_path), sdk_root=str(sdk), avd_home=str(avd_home), runner=rec.run, popen=rec.popen, which=lambda name: name)

    service.create("brproxies_phone_5556")
    service.start("brproxies_phone_5556", 5556)
    service.open_screen(5556)
    service.stop(5556)
    service.delete("brproxies_phone_5556")

    assert rec.runs[0][0][:4] == ["avdmanager", "create", "avd", "--force"]
    assert "brproxies_phone_5556" in rec.runs[0][0]
    assert rec.popens[0][0] == ["emulator", "-avd", "brproxies_phone_5556", "-port", "5556", "-gpu", "host", "-no-window", "-no-boot-anim", "-no-audio"]
    assert any(run[0] == ["adb", "-s", "emulator-5556", "wait-for-device"] for run in rec.runs)
    assert any(run[0] == ["adb", "-s", "emulator-5556", "shell", "getprop", "sys.boot_completed"] for run in rec.runs)
    assert any(run[0][:7] == ["adb", "-s", "emulator-5556", "shell", "pm", "disable-user", "--user"] for run in rec.runs)
    assert rec.popens[1][0] == ["scrcpy", "-s", "emulator-5556", "--no-audio", "--max-size", "720", "--video-bit-rate", "4M"]
    assert any(run[0] == ["adb", "-s", "emulator-5556", "emu", "kill"] for run in rec.runs)
    assert any(run[0] == ["avdmanager", "delete", "avd", "--name", "brproxies_phone_5556"] for run in rec.runs)

def test_avd_service_writes_lightweight_config(tmp_path):
    service = AvdService(data_dir=str(tmp_path), avd_home=str(tmp_path / "avd"), which=lambda name: name)

    service.optimize_config("phone_a")

    body = (tmp_path / "avd" / "phone_a.avd" / "config.ini").read_text(encoding="utf-8")
    assert "hw.lcd.width=720" in body
    assert "hw.lcd.height=1280" in body
    assert "hw.lcd.density=320" in body
    assert "hw.ramSize=2048" in body
    assert "hw.gpu.mode=host" in body
    assert "hw.camera.back=none" in body
    assert "hw.camera.front=none" in body
    assert "hw.gps=no" in body
    assert "hw.audioInput=no" in body
    assert "hw.audioOutput=no" in body
    assert "showDeviceFrame=no" in body
    assert "fastboot.forceColdBoot" not in body


def test_avd_service_rejects_missing_required_tool(tmp_path):
    service = AvdService(data_dir=str(tmp_path), which=lambda name: None)

    try:
        service.create("phone")
    except RuntimeError as err:
        assert "avdmanager" in str(err)
    else:
        raise AssertionError("missing avdmanager should fail")


def test_avd_open_screen_is_optional_when_scrcpy_is_missing(tmp_path):
    service = AvdService(data_dir=str(tmp_path), which=lambda name: None)

    assert service.open_screen(5556) is False


def test_avd_service_selects_installed_playstore_image(tmp_path):
    sdk = tmp_path / "Sdk"
    image = sdk / "system-images" / "android-35" / "google_apis_playstore" / "x86_64"
    image.mkdir(parents=True)
    (image / "package.xml").write_text("", encoding="utf-8")
    service = AvdService(data_dir=str(tmp_path), sdk_root=str(sdk), which=lambda name: name)

    assert service.resolve_system_image() == "system-images;android-35;google_apis_playstore;x86_64"

def test_avd_service_prefers_google_apis_over_playstore(tmp_path):
    sdk = tmp_path / "Sdk"
    play = sdk / "system-images" / "android-35" / "google_apis_playstore" / "x86_64"
    apis = sdk / "system-images" / "android-35" / "google_apis" / "x86_64"
    play.mkdir(parents=True)
    apis.mkdir(parents=True)
    (play / "package.xml").write_text("", encoding="utf-8")
    (apis / "package.xml").write_text("", encoding="utf-8")
    service = AvdService(data_dir=str(tmp_path), sdk_root=str(sdk), which=lambda name: name)

    assert service.resolve_system_image() == "system-images;android-35;google_apis;x86_64"

def test_avd_start_uses_window_when_scrcpy_missing(tmp_path):
    rec = Recorder()
    service = AvdService(data_dir=str(tmp_path), avd_home=str(tmp_path / "avd"), runner=rec.run, popen=rec.popen, which=lambda name: None if name == "scrcpy" else name)

    service.start("phone_a", 5556)

    assert "-no-window" not in rec.popens[0][0]


def test_avd_service_selects_newer_installed_api_image(tmp_path):
    sdk = tmp_path / "Sdk"
    image = sdk / "system-images" / "android-36.1" / "google_apis_playstore" / "x86_64"
    image.mkdir(parents=True)
    (image / "package.xml").write_text("", encoding="utf-8")
    service = AvdService(data_dir=str(tmp_path), sdk_root=str(sdk), which=lambda name: name)

    assert service.resolve_system_image() == "system-images;android-36.1;google_apis_playstore;x86_64"


def test_avd_service_rejects_incomplete_installer_stub_image(tmp_path):
    sdk = tmp_path / "Sdk"
    image = sdk / "system-images" / "android-35" / "google_apis_playstore" / "x86_64"
    image.mkdir(parents=True)
    (image / ".installer").mkdir()
    service = AvdService(data_dir=str(tmp_path), sdk_root=str(sdk), which=lambda name: name)

    try:
        service.resolve_system_image()
    except RuntimeError as err:
        assert "No Android x86_64 system image is installed" in str(err)
    else:
        raise AssertionError("incomplete installer stub should not be accepted")


def test_avd_service_checks_existing_avd_by_name(tmp_path):
    kwargs_seen = []
    class Runner:
        def __call__(self, args, **kwargs):
            kwargs_seen.append(kwargs)
            class Result:
                stdout = "Available Android Virtual Devices:\n    Name: phone_a\n    Path: C:\\avd\\phone_a.avd\n"
            return Result()

    service = AvdService(data_dir=str(tmp_path), runner=Runner(), which=lambda name: name, java_home="C:\\Android Studio\\jbr")

    assert service.exists("phone_a") is True
    assert service.exists("phone_b") is False
    assert kwargs_seen[0]["env"]["JAVA_HOME"] == "C:\\Android Studio\\jbr"

def test_avd_service_discovers_running_avds(tmp_path):
    class Runner:
        def __call__(self, args, **kwargs):
            class Result:
                stdout = ""
            result = Result()
            if args == ["adb", "devices", "-l"]:
                result.stdout = "List of devices attached\nemulator-5558 device product:sdk_gphone64_x86_64\n"
            elif args == ["adb", "-s", "emulator-5558", "emu", "avd", "name"]:
                result.stdout = "brproxies_android_phone_1_5558\nOK\n"
            return result

    service = AvdService(data_dir=str(tmp_path), runner=Runner(), which=lambda name: name)

    running = service.running_avds()
    assert len(running) == 1
    assert running[0].name == "brproxies_android_phone_1_5558"
    assert running[0].console_port == 5558

def test_avd_service_reports_offline_state_and_blocks_proxy(tmp_path):
    class Runner:
        def __call__(self, args, **kwargs):
            class Result:
                stdout = ""
            result = Result()
            if args == ["adb", "devices", "-l"]:
                result.stdout = "List of devices attached\nemulator-5556 offline\n"
            return result

    service = AvdService(data_dir=str(tmp_path), runner=Runner(), which=lambda name: name)

    assert service.adb_state(5556) == "offline"
    try:
        service.set_http_proxy(5556, "127.0.0.1", 8080)
    except RuntimeError as err:
        assert "emulator-5556 is offline" in str(err)
    else:
        raise AssertionError("offline emulator should not accept proxy changes")
