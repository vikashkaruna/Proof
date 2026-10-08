"""Axiom Proof — Agent Runtime entry point.

Usage:
    uvicorn axiom.app:app --host 0.0.0.0 --port 8000
"""

import uvicorn

from .config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "axiom.app:app",
        host=settings.http_host,
        port=settings.http_port,
        log_level=settings.log_level.lower(),
        access_log=False,
    )


if __name__ == "__main__":
    main()
