from pathlib import Path

from android_manager.tool_locator import find_android_tool


def test_find_android_tool_uses_android_sdk_root(tmp_path, monkeypatch):
    sdk = tmp_path / "Sdk"
    tool = sdk / "platform-tools" / "adb.exe"
    tool.parent.mkdir(parents=True)
    tool.write_text("", encoding="utf-8")
    monkeypatch.setenv("ANDROID_SDK_ROOT", str(sdk))
    monkeypatch.setattr("android_manager.tool_locator.shutil.which", lambda name: None)

    assert find_android_tool("adb") == str(tool)


def test_find_android_tool_uses_localappdata_default_sdk(tmp_path, monkeypatch):
    sdk = tmp_path / "Android" / "Sdk"
    tool = sdk / "emulator" / "emulator.exe"
    tool.parent.mkdir(parents=True)
    tool.write_text("", encoding="utf-8")
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr("android_manager.tool_locator.shutil.which", lambda name: None)

    assert find_android_tool("emulator") == str(tool)


def test_find_android_tool_supports_cmdline_tools_latest(tmp_path, monkeypatch):
    sdk = tmp_path / "Sdk"
    tool = sdk / "cmdline-tools" / "latest" / "bin" / "avdmanager.bat"
    tool.parent.mkdir(parents=True)
    tool.write_text("", encoding="utf-8")
    monkeypatch.setenv("ANDROID_HOME", str(sdk))
    monkeypatch.setattr("android_manager.tool_locator.shutil.which", lambda name: None)

    assert Path(find_android_tool("avdmanager") or "").name == "avdmanager.bat"
