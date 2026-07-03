import pytest

from android_manager.ports import allocate_adb_port


def test_allocate_first_free_port():
    assert allocate_adb_port({5555, 5556}, 5555, 5558) == 5557


def test_allocate_raises_when_range_full():
    with pytest.raises(RuntimeError, match="no free ADB port"):
        allocate_adb_port({5555, 5556}, 5555, 5556)
