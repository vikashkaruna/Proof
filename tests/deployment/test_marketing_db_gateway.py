"""Private gateway routing, credential separation and uncertain-write receipts."""
import importlib.util
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import URLError
from urllib.request import ProxyHandler
from http.server import ThreadingHTTPServer

SPEC = importlib.util.spec_from_file_location("marketing_db_gateway", Path(__file__).resolve().parents[2] / "services/marketing-db-gateway/gateway.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def receipt(raw, code=200, headers=None):
    result = Mock()
    result.code, result.headers = code, headers or {}
    result.read.return_value = raw
    result.__enter__ = Mock(return_value=result)
    result.__exit__ = Mock(return_value=False)
    return result


class MarketingGatewayTests(unittest.TestCase):
    def setUp(self):
        self.proxy = MODULE.Proxy("https://axiom-proof-preprod-rest-example-el.a.run.app")
        self.proxy.opener = Mock()

    def identity(self):
        return receipt(b"header.payload.signature", headers={"Metadata-Flavor": "Google"})

    def test_only_verified_run_origin(self):
        for value in ["http://localhost", "https://rest.run.app.evil.test", "https://rest.run.app/path", "https://user@rest.run.app", "https://rest.run.app?target=other", "https://rest.run.app\n", "https://rest.run.app/"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.Proxy(value)

    def test_credentialed_requests_ignore_ambient_http_proxies(self):
        with patch("urllib.request.getproxies", return_value={"https": "http://attacker.invalid:8080"}):
            proxy = MODULE.Proxy("https://axiom-proof-preprod-rest-example-el.a.run.app")
        handlers = [item for item in proxy.opener.handlers if isinstance(item, ProxyHandler)]
        self.assertEqual(handlers, [])

    def test_unapproved_paths_methods_and_encoded_paths_never_get_identity(self):
        for method, path in [("POST", "/rest/v1/rpc/append_ledger"), ("GET", "/rest/v1/rpc/take_rate_limit"), ("DELETE", "/rest/v1/contact_inquiries"), ("POST", "/auth/v1/signup"), ("POST", "/rest/v1/%63ontact_inquiries"), ("POST", "https://evil.test/rest/v1/contact_inquiries")]:
            with self.subTest(path=path):
                self.assertEqual(self.proxy.forward(method, path, {}, b"{}")[0], 404)
        self.proxy.opener.open.assert_not_called()

    def test_jwt_retained_and_caller_cloud_identity_replaced(self):
        self.proxy.opener.open.side_effect = [self.identity(), receipt(b'[{"id":"accepted"}]', code=201)]
        status, _, raw = self.proxy.forward("POST", "/rest/v1/contact_inquiries?select=id", {"Authorization": "Bearer database-jwt", "X-Serverless-Authorization": "untrusted", "Host": "evil.test", "Prefer": "return=representation"}, b"{}")
        self.assertEqual((status, raw), (201, b'[{"id":"accepted"}]'))
        request = self.proxy.opener.open.call_args_list[1].args[0]
        self.assertEqual(request.full_url, self.proxy.upstream + "/contact_inquiries?select=id")
        self.assertEqual(request.get_header("Authorization"), "Bearer database-jwt")
        self.assertEqual(request.get_header("X-serverless-authorization"), "Bearer header.payload.signature")
        self.assertIsNone(request.get_header("Host"))

    def test_rate_limit_rpc_is_forwarded(self):
        self.proxy.opener.open.side_effect = [self.identity(), receipt(b"true")]
        self.assertEqual(self.proxy.forward("POST", "/rest/v1/rpc/take_rate_limit", {}, b"{}")[0], 200)

    def test_identity_failure_is_proven_not_started(self):
        self.proxy.opener.open.side_effect = URLError("secret-provider-detail")
        status, headers, body = self.proxy.forward("POST", "/rest/v1/contact_inquiries", {}, b"{}")
        self.assertEqual(status, 503)
        self.assertEqual(headers["X-Axiom-DB-Outcome"], "not-started")
        self.assertNotIn(b"secret-provider-detail", body)
        self.assertEqual(self.proxy.opener.open.call_count, 1)

    def test_lost_write_receipt_blocks_safe_release(self):
        self.proxy.opener.open.side_effect = [self.identity(), URLError("timeout after upstream write")]
        status, headers, _ = self.proxy.forward("POST", "/rest/v1/contact_inquiries", {}, b"{}")
        self.assertEqual(status, 503)
        self.assertEqual(headers["X-Axiom-DB-Outcome"], "unknown")

    def test_provider_5xx_and_oversized_receipts_are_uncertain(self):
        for response in [receipt(b"unavailable", code=503), receipt(b"a" * (MODULE.MAX_BYTES + 1))]:
            self.proxy.opener.open.side_effect = [self.identity(), response]
            status, headers, _ = self.proxy.forward("POST", "/rest/v1/contact_inquiries", {}, b"{}")
            self.assertEqual(status, 503)
            self.assertEqual(headers["X-Axiom-DB-Outcome"], "unknown")

    def test_loopback_http_framing_rejects_get_body_and_ambiguous_lengths(self):
        proxy = Mock()
        proxy.forward.return_value = (200, {"Content-Type": "application/json"}, b'{"ok":true}')
        server = ThreadingHTTPServer(("127.0.0.1", 0), MODULE.handler(proxy))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        def exchange(raw):
            with socket.create_connection(server.server_address, timeout=2) as connection:
                connection.settimeout(2)
                connection.sendall(raw)
                connection.shutdown(socket.SHUT_WR)
                chunks = []
                while chunk := connection.recv(4096):
                    chunks.append(chunk)
            return b"".join(chunks)

        try:
            for raw in (
                b"GET /rest/v1/contact_inquiries HTTP/1.1\r\nHost: local\r\nContent-Length: 4\r\n\r\nbody",
                b"POST /rest/v1/contact_inquiries HTTP/1.1\r\nHost: local\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
                b"POST /rest/v1/contact_inquiries HTTP/1.1\r\nHost: local\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
                b"POST /rest/v1/contact_inquiries HTTP/1.1\r\nHost: local\r\n\r\n",
                b"POST /rest/v1/contact_inquiries HTTP/1.1\r\nHost: local\r\nContent-Length: 1048577\r\n\r\n",
            ):
                with self.subTest(raw=raw[:45]):
                    response = exchange(raw)
                    self.assertTrue(response.startswith((b"HTTP/1.0 400", b"HTTP/1.0 413")), response[:100])
                    self.assertIn(b"Cache-Control: no-store", response)
            proxy.forward.assert_not_called()
            valid = exchange(b"GET /rest/v1/contact_inquiries HTTP/1.1\r\nHost: local\r\n\r\n")
            self.assertTrue(valid.startswith(b"HTTP/1.0 200"), valid[:100])
            self.assertIn(b"Content-Length: 11", valid)
            proxy.forward.assert_called_once_with("GET", "/rest/v1/contact_inquiries", {"Host": "local"}, None)
            health = exchange(b"GET /health HTTP/1.1\r\nHost: local\r\n\r\n")
            self.assertTrue(health.startswith(b"HTTP/1.0 200"), health[:100])
            self.assertEqual(proxy.forward.call_count, 1)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
