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
    service = AvdService(data_dir=str(tmp_path), runner=rec.run, popen=rec.popen, which=lambda name: name)

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
