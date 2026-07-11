"""Launch the FastAPI backend via uvicorn."""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence

import uvicorn


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse portable launch options with loopback-safe defaults."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host",
        default=os.environ.get("VIDEO_DEPTH_HOST", "127.0.0.1"),
        help="Bind address (default: 127.0.0.1 or VIDEO_DEPTH_HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("VIDEO_DEPTH_PORT", "8000")),
        help="Listen port (default: 8000 or VIDEO_DEPTH_PORT)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Reload the backend when Python source files change",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
