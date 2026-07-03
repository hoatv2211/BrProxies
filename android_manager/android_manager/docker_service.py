from __future__ import annotations

import subprocess


class DockerService:
    def __init__(self, fake: bool = False) -> None:
        self.fake = fake

    def run_redroid(self, container_name: str, volume_name: str, adb_port: int, image: str) -> None:
        if self.fake:
            return
        subprocess.run(["docker", "volume", "create", volume_name], check=True)
        subprocess.run(
            [
                "docker", "run", "-d", "--privileged",
                "--name", container_name,
                "-v", f"{volume_name}:/data",
                "-p", f"127.0.0.1:{adb_port}:5555",
                image,
            ],
            check=True,
        )

    def start(self, container_name: str) -> None:
        if not self.fake:
            subprocess.run(["docker", "start", container_name], check=True)

    def stop(self, container_name: str) -> None:
        if not self.fake:
            subprocess.run(["docker", "stop", container_name], check=True)

    def delete(self, container_name: str, volume_name: str) -> None:
        if self.fake:
            return
        subprocess.run(["docker", "rm", "-f", container_name], check=False)
        subprocess.run(["docker", "volume", "rm", volume_name], check=False)
