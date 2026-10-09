"""Fixed Google REST targets, metadata identity; no developer tokens or SQL credentials."""

from __future__ import annotations

import json
import re
from http.client import HTTPMessage
from typing import IO, cast
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from lifecycle import Conflict, State, Target, Unavailable, unique_object

MAX_RESPONSE = 1024 * 1024


def decode(raw: bytes) -> object:
    try:
        return json.loads(raw, object_pairs_hook=unique_object)
    except RecursionError:
        raise ValueError("invalid_json") from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> Request | None:
        raise Unavailable("redirect_refused")


class GoogleHTTP:
    def __init__(self) -> None:
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def _fetch(self, request: Request) -> bytes:
        try:
            with self.opener.open(request, timeout=5) as response:
                raw = response.read(MAX_RESPONSE + 1)
                if not isinstance(raw, bytes) or len(raw) > MAX_RESPONSE:
                    raise Unavailable("provider_reply_too_large")
                return raw
        except HTTPError as error:
            if error.code == 412:
                raise Conflict from None
            raise Unavailable("provider_request_failed") from None
        except (URLError, OSError, ValueError):
            raise Unavailable("provider_request_failed") from None

    def request(self, method: str, url: str, body: bytes | None = None) -> object:
        if not url.startswith(
            ("https://storage.googleapis.com/", "https://sqladmin.googleapis.com/")
        ):
            raise Unavailable("target_refused")
        raw_token = self._fetch(
            Request(
                "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                headers={"Metadata-Flavor": "Google"},
            )
        )
        try:
            token = decode(raw_token)
            if (
                not isinstance(token, dict)
                or not isinstance(token.get("access_token"), str)
                or not token["access_token"]
                or token.get("token_type") != "Bearer"
                or type(token.get("expires_in")) is not int
                or token["expires_in"] <= 0
            ):
                raise ValueError
            raw = self._fetch(
                Request(
                    url,
                    data=body,
                    method=method,
                    headers={
                        "Authorization": "Bearer " + token["access_token"],
                        "Content-Type": "application/json",
                    },
                )
            )
            return decode(raw)
        except (ValueError, UnicodeError):
            raise Unavailable("invalid_provider_reply") from None


class GCSStore:
    def __init__(self, target: Target, http: GoogleHTTP):
        self.target, self.http = target, http
        self.url = (
            "https://storage.googleapis.com/storage/v1/b/"
            + quote(target.bucket, safe="")
            + "/o/"
            + quote(target.object_name, safe="")
        )

    def read(self) -> tuple[str, object]:
        metadata = self.http.request("GET", self.url)
        if (
            not isinstance(metadata, dict)
            or metadata.get("name") != self.target.object_name
            or metadata.get("bucket") != self.target.bucket
            or not isinstance(metadata.get("generation"), str)
            or not re.fullmatch(r"[1-9][0-9]{0,29}", metadata["generation"])
        ):
            raise Unavailable("invalid_state_metadata")
        generation = metadata["generation"]
        state = self.http.request(
            "GET", self.url + "?alt=media&generation=" + generation
        )
        return generation, state

    def write(self, generation: str, state: State) -> None:
        if not re.fullmatch(r"[1-9][0-9]{0,29}", generation):
            raise Unavailable("invalid_generation")
        url = (
            "https://storage.googleapis.com/upload/storage/v1/b/"
            + quote(self.target.bucket, safe="")
            + "/o?uploadType=media&name="
            + quote(self.target.object_name, safe="")
            + "&ifGenerationMatch="
            + generation
        )
        result = self.http.request(
            "POST", url, json.dumps(state, separators=(",", ":")).encode()
        )
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("generation"), str)
            or result["generation"] == generation
            or result.get("name") != self.target.object_name
            or result.get("bucket") != self.target.bucket
        ):
            # The write may have happened: caller must reread, never infer success.
            raise Unavailable("state_write_uncertain")


class CloudSQL:
    def __init__(self, target: Target, http: GoogleHTTP):
        self.target, self.http = target, http
        self.base = "https://sqladmin.googleapis.com/v1/projects/" + quote(
            target.project, safe=""
        )
        self.url = self.base + "/instances/" + quote(target.instance, safe="")

    def _instance(self) -> dict[str, object]:
        data = self.http.request("GET", self.url)
        if (
            not isinstance(data, dict)
            or data.get("name") != self.target.instance
            or data.get("project") != self.target.project
            or not isinstance(data.get("settings"), dict)
        ):
            raise Unavailable("instance_proof_mismatch")
        return cast(dict[str, object], data)

    def instance(self) -> dict[str, object]:
        data = self._instance()
        settings = cast(dict[str, object], data["settings"])
        return {
            "state": data.get("state"),
            "activationPolicy": settings.get("activationPolicy"),
        }

    def _operation(
        self, data: object, expected: str | None = None
    ) -> dict[str, object]:
        if (
            not isinstance(data, dict)
            or data.get("targetId") != self.target.instance
            or data.get("targetProject") != self.target.project
            or not isinstance(data.get("name"), str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", data["name"])
            or (expected is not None and data["name"] != expected)
            or data.get("status") not in ("PENDING", "RUNNING", "DONE")
            or data.get("error")
        ):
            raise Unavailable("operation_proof_missing_or_failed")
        return cast(dict[str, object], data)

    def activate(self, policy: str) -> str:
        if policy not in ("ALWAYS", "NEVER"):
            raise Unavailable("policy_refused")
        current = self._instance()
        settings = cast(dict[str, object], current["settings"])
        version = settings.get("settingsVersion")
        if not isinstance(version, str) or not re.fullmatch(
            r"[1-9][0-9]{0,29}", version
        ):
            raise Unavailable("settings_version_missing")
        result = self.http.request(
            "PATCH",
            self.url,
            json.dumps(
                {"settings": {"activationPolicy": policy, "settingsVersion": version}},
                separators=(",", ":"),
            ).encode(),
        )
        return cast(str, self._operation(result)["name"])

    def operation_done(self, operation: str) -> bool:
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", operation):
            raise Unavailable("operation_refused")
        result = self.http.request(
            "GET", self.base + "/operations/" + quote(operation, safe="")
        )
        return self._operation(result, operation)["status"] == "DONE"
