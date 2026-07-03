from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class AndroidInstanceCreate:
    name: str
    image: str
    proxy_id: str | None = None


@dataclass(slots=True)
class AndroidInstance:
    id: str
    name: str
    image: str
    adb_host: str
    adb_port: int
    container_name: str
    volume_name: str
    status: str
    proxy_id: str | None
    created_at: str
    updated_at: str
