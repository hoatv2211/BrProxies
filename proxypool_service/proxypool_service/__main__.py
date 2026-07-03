from __future__ import annotations

import argparse
import json
import logging

import uvicorn

from .api import create_app
from .config import load_config
from .sources import source_status


def main() -> None:
    parser = argparse.ArgumentParser(prog="brproxies-proxypool")
    sub = parser.add_subparsers(dest="cmd")

    serve = sub.add_parser("serve")
    serve.add_argument("--config", default=None)

    scheduler = sub.add_parser("scheduler")
    scheduler.add_argument("--config", default=None)

    sources = sub.add_parser("sources")
    sources.add_argument("--config", default=None)

    args = parser.parse_args()
    cmd = args.cmd or "serve"
    config = load_config(getattr(args, "config", None))

    if cmd == "sources":
        print(json.dumps(source_status(config), indent=2))
        return
    if cmd in {"serve", "scheduler"}:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
        app = create_app(config, start_scheduler=True)
        uvicorn.run(app, host=config.host, port=config.port, log_level="info")
        return
    parser.error(f"unknown command: {cmd}")


if __name__ == "__main__":
    main()
