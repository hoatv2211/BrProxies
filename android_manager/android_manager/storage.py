from __future__ import annotations

import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Iterator

from android_manager.models import AndroidInstance, AndroidInstanceCreate


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AndroidStore:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._connection() as conn:
            conn.execute(
                """
                create table if not exists android_instances (
                  id text primary key,
                  name text not null,
                  image text not null,
                  adb_host text not null,
                  adb_port integer not null unique,
                  container_name text not null unique,
                  volume_name text not null unique,
                  status text not null,
                  proxy_id text,
                  created_at text not null,
                  updated_at text not null
                )
                """
            )

    def list_instances(self) -> list[AndroidInstance]:
        with self._connection() as conn:
            rows = conn.execute("select * from android_instances order by created_at desc").fetchall()
        return [AndroidInstance(**dict(row)) for row in rows]

    def get_instance(self, instance_id: str) -> AndroidInstance:
        with self._connection() as conn:
            row = conn.execute("select * from android_instances where id = ?", (instance_id,)).fetchone()
        if row is None:
            raise KeyError(instance_id)
        return AndroidInstance(**dict(row))

    def used_adb_ports(self) -> set[int]:
        return {item.adb_port for item in self.list_instances()}

    def create_instance(
        self,
        body: AndroidInstanceCreate,
        adb_port: int,
        container_name: str,
        volume_name: str,
        status: str = "created",
    ) -> AndroidInstance:
        instance_id = uuid.uuid4().hex
        now = _now()
        item = AndroidInstance(
            id=instance_id,
            name=body.name,
            image=body.image,
            adb_host="127.0.0.1",
            adb_port=adb_port,
            container_name=container_name,
            volume_name=volume_name,
            status=status,
            proxy_id=body.proxy_id,
            created_at=now,
            updated_at=now,
        )
        with self._connection() as conn:
            conn.execute(
                """
                insert into android_instances
                (id, name, image, adb_host, adb_port, container_name, volume_name, status, proxy_id, created_at, updated_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (item.id, item.name, item.image, item.adb_host, item.adb_port, item.container_name, item.volume_name, item.status, item.proxy_id, item.created_at, item.updated_at),
            )
        return item

    def set_status(self, instance_id: str, status: str) -> AndroidInstance:
        now = _now()
        with self._connection() as conn:
            cur = conn.execute("update android_instances set status = ?, updated_at = ? where id = ?", (status, now, instance_id))
            rowcount = cur.rowcount
        if rowcount == 0:
            raise KeyError(instance_id)
        return self.get_instance(instance_id)

    def set_proxy(self, instance_id: str, proxy_id: str | None) -> AndroidInstance:
        now = _now()
        with self._connection() as conn:
            cur = conn.execute("update android_instances set proxy_id = ?, updated_at = ? where id = ?", (proxy_id, now, instance_id))
            rowcount = cur.rowcount
        if rowcount == 0:
            raise KeyError(instance_id)
        return self.get_instance(instance_id)

    def delete_instance(self, instance_id: str) -> None:
        with self._connection() as conn:
            cur = conn.execute("delete from android_instances where id = ?", (instance_id,))
            rowcount = cur.rowcount
        if rowcount == 0:
            raise KeyError(instance_id)
