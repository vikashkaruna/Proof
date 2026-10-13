"""Axiom Model Gateway — entry point."""

import uvicorn

from .app import app
from .config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        app,
        host=settings.http_host,
        port=settings.http_port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
