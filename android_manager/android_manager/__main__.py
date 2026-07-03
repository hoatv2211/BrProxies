from __future__ import annotations

import argparse

import uvicorn

from android_manager.api import create_app
from android_manager.config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(prog="brproxies-android-manager")
    parser.add_argument("command", nargs="?", default="serve", choices=["serve"])
    parser.add_argument("--config", default=None)
    args = parser.parse_args()
    cfg = load_config(args.config)
    uvicorn.run(create_app(), host=cfg.host, port=cfg.port)


if __name__ == "__main__":
    main()
