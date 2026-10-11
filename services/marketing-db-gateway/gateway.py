"""Private marketing-only PostgREST proxy. Cloud Run IAM verifies its caller.

The existing Supabase JWT stays in Authorization; an independently acquired
Cloud Run identity goes in X-Serverless-Authorization. No credentials are logged.
"""
from __future__ import annotations

import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BYTES = 1024 * 1024
FORWARD_HEADERS = {"authorization", "apikey", "content-type", "prefer", "accept", "accept-profile", "content-profile", "range", "range-unit"}
REPLY_HEADERS = {"content-type", "content-range", "preference-applied", "range-unit"}


def origin(value: str) -> str:
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app", url.hostname) or url.username or url.password or url.port or url.path or url.query or url.fragment or value != f"https://{url.hostname}":
        raise ValueError("Verified Cloud Run upstream origin required")
    return value


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirect refused")


class Proxy:
    def __init__(self, upstream: str):
        self.upstream = origin(upstream)
        # Do not send the Supabase JWT or metadata request through ambient
        # HTTP(S)_PROXY settings inherited by the container.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def forward(self, method: str, path: str, headers: dict[str, str], body: bytes | None) -> tuple[int, dict[str, str], bytes]:
        parsed = urlsplit(path)
        allowed = parsed.path in ("/rest/v1/gap_scan_responses", "/rest/v1/contact_inquiries") and method in ("GET", "POST", "PATCH")
        allowed = allowed or (parsed.path == "/rest/v1/rpc/take_rate_limit" and method == "POST")
        if not allowed or parsed.scheme or parsed.netloc or parsed.fragment or len(path) > 8192:
            return 404, {}, b'{"error":"not_found"}'
        if body is not None and len(body) > MAX_BYTES:
            return 413, {}, b'{"error":"request_too_large"}'
        try:
            request = Request("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" + quote(self.upstream, safe="") + "&format=full", headers={"Metadata-Flavor": "Google"})
            with self.opener.open(request, timeout=3) as response:
                token = response.read(16385).decode("ascii")
                if response.headers.get("Metadata-Flavor") != "Google" or not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token) or len(token) > 16384:
                    raise ValueError("Invalid identity receipt")
        except (ValueError, OSError, URLError):
            return 503, {"X-Axiom-DB-Outcome": "not-started"}, b'{"error":"upstream_identity_unavailable"}'
        outbound = {k: v for k, v in headers.items() if k.lower() in FORWARD_HEADERS}
        outbound["X-Serverless-Authorization"] = "Bearer " + token
        suffix = parsed.path.removeprefix("/rest/v1") + ("?" + parsed.query if parsed.query else "")
        try:
            request = Request(self.upstream + suffix, data=body, headers=outbound, method=method)
            try:
                response = self.opener.open(request, timeout=20)
            except HTTPError as error:
                response = error
            with response:
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise ValueError("Oversized upstream receipt")
                reply = {k: v for k, v in response.headers.items() if k.lower() in REPLY_HEADERS}
                if response.code >= 500:
                    reply["X-Axiom-DB-Outcome"] = "unknown"
                return response.code, reply, raw
        except (ValueError, OSError, URLError):
            return 503, {"X-Axiom-DB-Outcome": "unknown"}, b'{"error":"database_outcome_unknown"}'


def handler(proxy: Proxy):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def execute(self):
            if self.command == "GET" and self.path == "/health":
                status, headers, raw = 200, {}, b'{"status":"healthy","profile":"marketing-gateway"}'
            else:
                lengths = self.headers.get_all("Content-Length", [])
                if self.headers.get("Transfer-Encoding") or len(lengths) > 1 or (lengths and not lengths[0].isdigit()):
                    status, headers, raw = 400, {}, b'{"error":"invalid_framing"}'
                elif (self.command in ("POST", "PATCH") and not lengths) or (lengths and int(lengths[0]) > MAX_BYTES):
                    status, headers, raw = 413, {}, b'{"error":"invalid_body_length"}'
                elif self.command == "GET" and lengths and int(lengths[0]) != 0:
                    status, headers, raw = 400, {}, b'{"error":"invalid_body_length"}'
                else:
                    self.connection.settimeout(5)
                    length = int(lengths[0]) if lengths else 0
                    try:
                        body = self.rfile.read(length) if length else None
                        if body is not None and len(body) != length:
                            raise ValueError("Truncated body")
                        status, headers, raw = proxy.forward(self.command, self.path, dict(self.headers), body)
                    except (OSError, ValueError):
                        status, headers, raw = 400, {}, b'{"error":"invalid_body"}'
            self.send_response(status)
            self.send_header("Content-Type", headers.pop("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            for key, value in headers.items():
                if key.lower() != "content-type":
                    self.send_header(key, value)
            self.end_headers()
            self.wfile.write(raw)

        do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = do_OPTIONS = execute

    return Handler


if __name__ == "__main__":
    if os.environ.get("ENVIRONMENT") != "preprod":
        raise SystemExit("Marketing gateway requires preprod")
    # Cloud Run requires this listener: https://docs.cloud.google.com/run/docs/container-contract
    # services.tf grants gateway invoker exclusively to the gated BFF identity.
    ThreadingHTTPServer(("0.0.0.0", int(os.environ["PORT"])), handler(Proxy(os.environ["SUPABASE_REST_UPSTREAM"]))).serve_forever()  # nosec B104
