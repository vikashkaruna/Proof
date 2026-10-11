from __future__ import annotations

import io
import json
import threading
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, urlopen

import pytest
from google_rest import CloudSQL, GCSStore, GoogleHTTP, NoRedirect, decode
from lifecycle import Conflict, Controller, Target, Unavailable, bootstrap_state
from server import handler
from test_lifecycle import Cloud, Store, body


@pytest.fixture
def target():
    return Target(
        "synthetic-project",
        "synthetic-project-preprod-db",
        "synthetic-project-preprod-state-123",
        "marketing-preprod/lifecycle/state.json",
        "a" * 64,
    )


class Rest:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def request(self, method, url, body=None):
        self.calls.append((method, url, body))
        result = self.replies.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def instance(target):
    return {
        "project": target.project,
        "name": target.instance,
        "state": "RUNNABLE",
        "settings": {"activationPolicy": "ALWAYS", "settingsVersion": "42"},
    }


def operation(target):
    return {
        "name": "operation-1",
        "targetProject": target.project,
        "targetId": target.instance,
        "status": "PENDING",
    }


def test_native_store_reads_generation_pinned_body_and_cas_writes(target):
    state = bootstrap_state(target, now=1000, phase="running")
    http = Rest(
        [
            {"generation": "7", "name": target.object_name, "bucket": target.bucket},
            state,
            {"generation": "8", "name": target.object_name, "bucket": target.bucket},
        ]
    )
    store = GCSStore(target, http)
    assert store.read() == ("7", state)
    store.write("7", state)
    assert http.calls[1][1].endswith("?alt=media&generation=7")
    assert "&ifGenerationMatch=7" in http.calls[2][1]
    assert "marketing-preprod%2Flifecycle%2Fstate.json" in http.calls[2][1]
    assert json.loads(http.calls[2][2]) == state


def test_native_store_generation_conflict_is_explicit(target):
    store = GCSStore(target, Rest([Conflict()]))
    with pytest.raises(Conflict):
        store.write("7", bootstrap_state(target, now=1000, phase="running"))


@pytest.mark.parametrize(
    "reply",
    [
        {"generation": "1", "name": "other", "bucket": "other"},
        {"generation": "same", "name": "other"},
        {},
    ],
)
def test_state_metadata_and_write_missing_proof_refused(target, reply):
    with pytest.raises(Unavailable):
        GCSStore(target, Rest([reply])).read()
    with pytest.raises(Unavailable):
        GCSStore(target, Rest([reply])).write(
            "1", bootstrap_state(target, now=1000, phase="running")
        )


def test_cloud_patch_only_activation_policy_current_settings_version(target):
    http = Rest([instance(target), operation(target)])
    sql = CloudSQL(target, http)
    assert sql.activate("NEVER") == "operation-1"
    method, url, raw = http.calls[1]
    assert method == "PATCH"
    assert (
        url
        == f"https://sqladmin.googleapis.com/v1/projects/{target.project}/instances/{target.instance}"
    )
    assert json.loads(raw) == {
        "settings": {"activationPolicy": "NEVER", "settingsVersion": "42"}
    }


@pytest.mark.parametrize(
    "change",
    [
        {"targetProject": "other-project"},
        {"targetId": "production-db"},
        {"name": "../foreign"},
        {"status": "UNKNOWN"},
        {"error": {"errors": [{"code": "failed"}]}},
    ],
)
def test_native_operation_target_failure_mismatch_refused(target, change):
    result = {**operation(target), **change}
    with pytest.raises(Unavailable):
        CloudSQL(target, Rest([instance(target), result])).activate("ALWAYS")
    with pytest.raises(Unavailable):
        CloudSQL(target, Rest([result])).operation_done("operation-1")


def test_operation_poll_exact_name_and_done_required(target):
    sql = CloudSQL(
        target, Rest([operation(target), {**operation(target), "status": "DONE"}])
    )
    assert sql.operation_done("operation-1") is False
    assert sql.operation_done("operation-1") is True
    with pytest.raises(Unavailable):
        CloudSQL(
            target,
            Rest([{**operation(target), "name": "operation-2", "status": "DONE"}]),
        ).operation_done("operation-1")


@pytest.mark.parametrize(
    "change",
    [{"project": "other-project"}, {"name": "other-instance"}, {"settings": {}}],
)
def test_wrong_instance_or_missing_version_cannot_patch(target, change):
    http = Rest([{**instance(target), **change}])
    with pytest.raises(Unavailable):
        CloudSQL(target, http).activate("NEVER")
    assert len(http.calls) == 1


def test_duplicate_json_keys_refused():
    with pytest.raises(ValueError):
        decode(b'{"requestId":"original","requestId":"changed"}')


class Opener:
    def __init__(self, replies):
        self.replies = replies
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        result = self.replies.pop(0)
        if isinstance(result, Exception):
            raise result
        return io.BytesIO(result)


def test_metadata_identity_native_http_never_developer_credentials(monkeypatch):
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/must-not-open")
    http = GoogleHTTP()
    http.opener = Opener(
        [
            b'{"access_token":"synthetic-token","token_type":"Bearer","expires_in":3600}',
            b'{"status":"PENDING"}',
        ]
    )
    assert http.request(
        "GET",
        "https://sqladmin.googleapis.com/v1/projects/synthetic-project/instances/synthetic-project-preprod-db",
    ) == {"status": "PENDING"}
    first, second = http.opener.calls
    assert (
        first[0].full_url
        == "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
    )
    assert first[0].get_header("Metadata-flavor") == "Google"
    assert second[0].get_header("Authorization") == "Bearer synthetic-token"
    assert first[1] == second[1] == 5


def test_http_redirect_and_arbitrary_endpoint_refused():
    with pytest.raises(Unavailable):
        GoogleHTTP().request("GET", "https://attacker.invalid/")
    with pytest.raises(Unavailable):
        NoRedirect().redirect_request(
            None, None, 302, "", None, "https://attacker.invalid/"
        )


def test_native_412_maps_to_cas_conflict_without_secret_error():
    http = GoogleHTTP()
    http.opener = Opener(
        [HTTPError("https://storage.googleapis.com", 412, "secret-reply", None, None)]
    )
    with pytest.raises(Conflict) as error:
        http._fetch(Request("https://storage.googleapis.com/"))
    assert "secret-reply" not in str(error.value)


@pytest.fixture
def server(target):
    store = Store(bootstrap_state(target, now=1000, phase="running"))
    controller = Controller(target, store, Cloud(), lambda: 1000)
    http = ThreadingHTTPServer(("127.0.0.1", 0), handler(controller))
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    yield "http://127.0.0.1:" + str(http.server_port), store
    http.shutdown()
    http.server_close()
    thread.join(timeout=2)


def post(url, raw):
    try:
        with urlopen(
            Request(url, data=raw, headers={"Content-Type": "application/json"}),
            timeout=3,
        ) as reply:
            return reply.status, dict(reply.headers), json.load(reply)
    except HTTPError as reply:
        return reply.code, dict(reply.headers), json.load(reply)


def test_actual_local_http_acquire_release_no_store(server):
    url, store = server
    request = body()
    status, headers, response = post(
        url + "/gate/acquire", json.dumps(request).encode()
    )
    assert status == 200
    assert headers["Cache-Control"] == "no-store"
    assert response["requestId"] == request["requestId"]
    assert len(store.state["leases"]) == 1
    assert post(url + "/gate/release", json.dumps(request).encode())[0] == 200
    assert store.state["leases"] == {}


@pytest.mark.parametrize(
    "raw",
    [
        b"x" * 4097,
        b"{}",
        b"[]",
        b'{"requestId":"one","requestId":"two"}',
        b'{"project":"production"}',
    ],
)
def test_actual_local_http_rejects_before_any_durable_write(server, raw):
    url, store = server
    assert post(url + "/gate/acquire", raw)[0] == 400
    assert store.generation == 1


def test_google_metadata_and_bearer_transport_never_uses_ambient_proxies(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:49299")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:49299")
    monkeypatch.setenv("NO_PROXY", "")
    http = GoogleHTTP()
    # Default urllib proxy handlers send both metadata and Google bearer tokens
    # through inherited proxy configuration. Empty handlers may be omitted.
    assert all(not h.proxies for h in http.opener.handlers if isinstance(h, ProxyHandler))
