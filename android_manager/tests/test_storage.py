from android_manager.models import AndroidInstanceCreate
from android_manager.storage import AndroidStore


def test_create_and_list_instance(tmp_path):
    store = AndroidStore(str(tmp_path / "android.sqlite3"))
    created = store.create_instance(
        AndroidInstanceCreate(name="phone-1", image="redroid/redroid:12.0.0-latest", proxy_id=None),
        adb_port=5555,
        container_name="brproxies-android-phone-1",
        volume_name="brproxies_android_phone_1_data",
    )
    assert created.name == "phone-1"
    assert created.status == "created"
    assert store.list_instances()[0].id == created.id


def test_status_proxy_and_delete(tmp_path):
    store = AndroidStore(str(tmp_path / "android.sqlite3"))
    created = store.create_instance(
        AndroidInstanceCreate(name="phone-2", image="redroid/redroid:12.0.0-latest"),
        adb_port=5556,
        container_name="brproxies-android-phone-2",
        volume_name="brproxies_android_phone_2_data",
    )
    assert store.set_status(created.id, "running").status == "running"
    assert store.set_proxy(created.id, "127.0.0.1:8080").proxy_id == "127.0.0.1:8080"
    store.delete_instance(created.id)
    assert store.list_instances() == []

def test_store_releases_sqlite_file_handle(tmp_path):
    db_path = tmp_path / "android.sqlite3"
    store = AndroidStore(str(db_path))
    created = store.create_instance(
        AndroidInstanceCreate(name="phone-3", image="redroid/redroid:12.0.0-latest"),
        adb_port=5557,
        container_name="brproxies-android-phone-3",
        volume_name="brproxies_android_phone_3_data",
    )
    store.set_status(created.id, "running")
    store.set_proxy(created.id, "127.0.0.1:8080")
    store.delete_instance(created.id)

    db_path.unlink()
    assert not db_path.exists()

def test_adopt_instance_upserts_by_adb_port(tmp_path):
    store = AndroidStore(str(tmp_path / "android.sqlite3"))

    created = store.adopt_instance(
        name="brproxies_android_phone_1_5558",
        image="system-images;android-35;google_apis_playstore;x86_64",
        adb_port=5558,
        container_name="brproxies_android_phone_1_5558",
        volume_name="brproxies_android_phone_1_5558_data",
    )
    updated = store.adopt_instance(
        name="brproxies_android_phone_1_5558",
        image="system-images;android-35;google_apis;x86_64",
        adb_port=5558,
        container_name="brproxies_android_phone_1_5558",
        volume_name="brproxies_android_phone_1_5558_data",
    )

    assert updated.id == created.id
    assert updated.status == "running"
    assert updated.image == "system-images;android-35;google_apis;x86_64"
    assert len(store.list_instances()) == 1

def test_adopt_instance_upserts_by_container_name(tmp_path):
    store = AndroidStore(str(tmp_path / "android.sqlite3"))
    created = store.adopt_instance(
        name="phone-a",
        image="system-images;android-35;google_apis;x86_64",
        adb_port=5556,
        container_name="brproxies_android_phone_a_5556",
        volume_name="brproxies_android_phone_a_5556_data",
        status="stopped",
    )

    updated = store.adopt_instance(
        name="phone-a",
        image="system-images;android-35;google_apis;x86_64",
        adb_port=5558,
        container_name="brproxies_android_phone_a_5556",
        volume_name="brproxies_android_phone_a_5556_data",
        status="running",
    )

    assert updated.id == created.id
    assert updated.adb_port == 5556
    assert updated.status == "running"
    assert len(store.list_instances()) == 1
