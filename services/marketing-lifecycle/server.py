"""Cloud Run IAM-authenticated ingress only. No public invoker grant is supported."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast

from google_rest import CloudSQL, GCSStore, GoogleHTTP, decode
from lifecycle import Controller, Target

MAX_BODY = 4096


def handler(controller: Controller) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass  # Never log request bodies, lease tokens or provider replies.

        def send(self, status: int, body: dict[str, object]) -> None:
            raw = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            if status == 503:
                self.send_header("Retry-After", "5")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if self.path == "/healthz":
                self.send(200, {"status": "ready"})
            else:
                self.send(404, {"status": "not_found"})

        def do_POST(self) -> None:
            try:
                if self.path not in ("/gate/acquire", "/gate/release", "/idle/check"):
                    self.send(404, {"status": "not_found"})
                    return
                # Duplicate/smuggled length or chunked requests must never reach CAS.
                lengths = self.headers.get_all("Content-Length", [])
                if (
                    len(lengths) != 1
                    or self.headers.get("Transfer-Encoding") is not None
                    or not lengths[0].isdigit()
                    or not 0 < int(lengths[0]) <= MAX_BODY
                    or self.headers.get_content_type() != "application/json"
                ):
                    self.send(400, {"status": "invalid_request", "saved": False})
                    return
                self.connection.settimeout(5)
                raw = self.rfile.read(int(lengths[0]))
                if len(raw) != int(lengths[0]):
                    raise ValueError
                body = decode(raw)
                if not isinstance(body, dict):
                    raise TypeError
                reply = controller.handle(self.path, cast(dict[str, object], body))
                self.send(reply.status, reply.body)
            except (TypeError, ValueError, UnicodeError, OSError, TimeoutError):
                self.send(400, {"status": "invalid_request", "saved": False})

    return Handler


def main() -> None:
    target = Target.from_environment(dict(os.environ))
    http = GoogleHTTP()
    controller = Controller(target, GCSStore(target, http), CloudSQL(target, http))
    port = int(os.environ.get("PORT", "8080"))
    # Cloud Run requires this listener: https://docs.cloud.google.com/run/docs/container-contract
    # lifecycle.tf grants invoker only to BFF/scheduler service identities.
    ThreadingHTTPServer(("0.0.0.0", port), handler(controller)).serve_forever()  # nosec B104


if __name__ == "__main__":
    main()
