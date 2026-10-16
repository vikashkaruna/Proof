"""Offline pinned-release diagnostic regressions; no download, Docker or identity."""

import ast
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts/test-workload-identity.py"


class ReleaseDiagnostics(unittest.TestCase):
    def setUp(self):
        owned = tempfile.TemporaryDirectory()
        self.addCleanup(owned.cleanup)
        self.root = Path(owned.name)
        self.temp = self.root / "temp"
        self.temp.mkdir()
        self.archive = self.root / "spire-1.15.3-linux-amd64-musl.tar.gz"
        self.messages = []
        self.calls = []
        self.env = {
            "Path": Path,
            "json": json,
            "hashlib": hashlib,
            "tarfile": tarfile,
            "subprocess": subprocess,
            "ROOT": self.root,
            "VERSION": "1.15.3",
            "HASHES": {},
            "print": lambda text, **kw: self.messages.append(text),
        }
        tree = ast.parse(SOURCE.read_text())
        names = {"IsolatedCommandFailure", "prepare_spire_release", "run"}
        selected = [
            n
            for n in tree.body
            if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names
        ]
        self.assertEqual(len(selected), 3)
        exec(  # noqa: S102 - fixed repository AST only; injected ports prevent host operations.
            compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), "exec"),
            self.env,
        )
        self.env["run"] = self.fake_run

    def fixture(self, *, missing=False, directory=False):
        target = self.root / "fixture.tar.gz"
        with tarfile.open(target, "w:gz") as archive:
            for executable in ("spire-server", "spire-agent"):
                if missing and executable == "spire-agent":
                    continue
                data = executable.encode()
                member = tarfile.TarInfo("spire-1.15.3/bin/" + executable)
                if directory:
                    member.type = tarfile.DIRTYPE
                else:
                    member.size = len(data)
                archive.addfile(member, None if directory else io.BytesIO(data))
            member = tarfile.TarInfo("unreviewed-script")
            member.size = 4
            archive.addfile(member, io.BytesIO(b"skip"))
        self.bytes = target.read_bytes()
        self.env["HASHES"]["amd64"] = hashlib.sha256(self.bytes).hexdigest()
        return self.bytes

    def fake_run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        Path(args[-1]).write_bytes(self.bytes)
        return SimpleNamespace(returncode=0)

    def prepare(self):
        return self.env["prepare_spire_release"](self.archive, self.temp, "amd64")

    def diagnostic(self):
        self.assertEqual(len(self.messages), 1)
        prefix = "Workload release setup failure: "
        self.assertTrue(self.messages[0].startswith(prefix))
        value = json.loads(self.messages[0][len(prefix) :])
        self.assertEqual(set(value), {"phase", "commandId", "errorKind", "exitCode"})
        self.assertNotIn("synthetic-secret", "".join(self.messages))
        self.assertNotIn("https://", "".join(self.messages))
        return value

    def test_download_preserves_exact_https_checksum_members_and_deadlines(self):
        data = self.fixture()
        self.prepare()
        self.assertEqual(self.archive.read_bytes(), data)
        self.assertEqual(len(self.calls), 1)
        args, kwargs = self.calls[0]
        self.assertEqual(
            args[:-3],
            [
                "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=https",
                "--tlsv1.2",
                "--retry",
                "2",
                "--max-time",
                "180",
            ],
        )
        self.assertEqual(
            args[-3],
            "https://github.com/spiffe/spire/releases/download/v1.15.3/"
            + self.archive.name,
        )
        self.assertEqual(args[-2:], ["--output", str(self.temp / "download.tar.gz")])
        self.assertEqual(kwargs, {"timeout": 190})
        self.assertEqual(
            sorted(p.name for p in self.temp.iterdir()), ["spire-agent", "spire-server"]
        )
        for name in ("spire-agent", "spire-server"):
            self.assertEqual((self.temp / name).read_bytes(), name.encode())
            self.assertEqual((self.temp / name).stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.messages, [])

    def test_cached_exact_archive_does_not_redownload(self):
        self.archive.write_bytes(self.fixture())
        self.prepare()
        self.assertEqual(self.calls, [])

    def test_command_exit_and_timeout_only_emit_allowlisted_diagnostics(self):
        self.fixture()
        for failure, kind, code in (
            (self.env["IsolatedCommandFailure"](22), "command_exit", 22),
            (
                subprocess.TimeoutExpired(
                    ["synthetic-secret-url"], 190, output="synthetic-secret"
                ),
                "timeout",
                None,
            ),
        ):
            self.messages.clear()
            self.env["run"] = lambda *a, failure=failure, **k: (_ for _ in ()).throw(
                failure
            )
            with self.assertRaises(type(failure)):
                self.prepare()
            self.assertEqual(
                self.diagnostic(),
                {
                    "phase": "download",
                    "commandId": "spire-release-download",
                    "errorKind": kind,
                    "exitCode": code,
                },
            )
            self.assertFalse((self.temp / "spire-server").exists())

    def test_download_and_cached_checksum_failure_remain_hard_refusals(self):
        self.fixture()
        self.env["HASHES"]["amd64"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "release checksum mismatch"):
            self.prepare()
        self.assertEqual(self.diagnostic()["phase"], "download_checksum")
        self.assertFalse(self.archive.exists())
        self.archive.write_bytes(self.bytes)
        self.messages.clear()
        with self.assertRaisesRegex(RuntimeError, "release checksum mismatch"):
            self.prepare()
        self.assertEqual(self.diagnostic()["phase"], "archive_checksum")
        self.assertFalse((self.temp / "spire-server").exists())

    def test_archive_format_missing_member_and_nonregular_member_refused(self):
        for kind in ("format", "missing", "nonregular"):
            self.messages.clear()
            if kind == "format":
                data = b"not a tar archive synthetic-secret"
                self.env["HASHES"]["amd64"] = hashlib.sha256(data).hexdigest()
            else:
                data = self.fixture(
                    missing=kind == "missing", directory=kind == "nonregular"
                )
            self.archive.write_bytes(data)
            with self.assertRaises((tarfile.TarError, KeyError, RuntimeError)):
                self.prepare()
            value = self.diagnostic()
            self.assertEqual(
                value["phase"], "archive_open" if kind == "format" else "member_select"
            )
            self.assertEqual(
                value["errorKind"],
                {
                    "format": "archive_format",
                    "missing": "missing_member",
                    "nonregular": "validation",
                }[kind],
            )

    def test_executable_io_failure_does_not_print_exception_text_or_path(self):
        self.archive.write_bytes(self.fixture())
        with (
            patch.object(
                Path,
                "chmod",
                side_effect=PermissionError("synthetic-secret /private/credential"),
            ),
            self.assertRaises(PermissionError),
        ):
            self.prepare()
        self.assertEqual(
            self.diagnostic(),
            {
                "phase": "executable_mode",
                "commandId": "none",
                "errorKind": "io",
                "exitCode": None,
            },
        )

    def test_run_keeps_runtimeerror_contract_and_only_public_exit_code(self):
        tree = ast.parse(SOURCE.read_text())
        node = next(
            n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "run"
        )
        env = {**self.env, "report_public_image_startup": lambda *a: None}
        exec(  # noqa: S102 - fixed repository AST only; injected ports prevent host operations.
            compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), "exec"), env
        )
        result = subprocess.CompletedProcess(
            ["curl"], 60, "synthetic-secret", "synthetic-secret"
        )
        with (
            patch.object(subprocess, "run", return_value=result),
            self.assertRaises(RuntimeError) as caught,
        ):
            env["run"](["curl"])
        self.assertEqual(caught.exception.returncode, 60)
        self.assertEqual(str(caught.exception), "isolated command failed")
        self.assertNotIn("synthetic-secret", repr(caught.exception))


if __name__ == "__main__":
    unittest.main()
