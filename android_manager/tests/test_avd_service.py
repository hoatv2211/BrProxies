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
    image = sdk / "system-images" / "android-35" / "google_apis" / "x86_64"
    image.mkdir(parents=True)
    (image / "package.xml").write_text("", encoding="utf-8")
    service = AvdService(data_dir=str(tmp_path), sdk_root=str(sdk), runner=rec.run, popen=rec.popen, which=lambda name: name)

    service.create("brproxies_phone_5556")
    service.start("brproxies_phone_5556", 5556)
    service.open_screen(5556)
    service.stop(5556)
    service.delete("brproxies_phone_5556")

    assert rec.runs[0][0][:4] == ["avdmanager", "create", "avd", "--force"]
    assert "brproxies_phone_5556" in rec.runs[0][0]
    assert rec.popens[0][0] == ["emulator", "-avd", "brproxies_phone_5556", "-port", "5556", "-no-snapshot-save"]
    assert rec.runs[1][0] == ["adb", "-s", "emulator-5556", "wait-for-device"]
    assert rec.runs[2][0] == ["adb", "-s", "emulator-5556", "shell", "getprop", "sys.boot_completed"]
    assert rec.popens[1][0] == ["scrcpy", "-s", "emulator-5556", "--no-audio"]
    assert rec.runs[3][0] == ["adb", "-s", "emulator-5556", "emu", "kill"]
    assert rec.runs[4][0] == ["avdmanager", "delete", "avd", "--name", "brproxies_phone_5556"]


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
