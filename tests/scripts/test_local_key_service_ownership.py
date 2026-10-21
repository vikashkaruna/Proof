"""Key helper cleanup cannot delete foreign names; subprocesses are mocked."""

import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "key_service_ownership",
    Path(__file__).resolve().parents[2] / "scripts/local-key-service.py",
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.name = "axiom-key-service-kosha-stage"
        self.purpose = "local-key-service-stage"
        self.value = {
            "id": "a" * 64,
            "name": "/" + self.name,
            "running": True,
            "labels": {"axiom.purpose": self.purpose},
        }

    def response(self, value):
        return subprocess.CompletedProcess([], 0, value, "")

    def test_absent_name_never_removed(self):
        with patch.object(m, "run", return_value=self.response("foreign\n")) as run:
            m.remove_owned(self.name, self.purpose)
            self.assertEqual(run.call_count, 1)

    def test_unlabelled_or_wrong_name_never_stopped(self):
        for value in [dict(self.value, labels={}), dict(self.value, name="/foreign")]:
            with (
                patch.object(
                    m,
                    "run",
                    side_effect=[
                        self.response(self.name + "\n"),
                        self.response(json.dumps(value)),
                    ],
                ) as run,
                self.assertRaises(ValueError),
            ):
                m.remove_owned(self.name, self.purpose)
            self.assertEqual(run.call_count, 2)

    def test_owned_helper_stops_gracefully_and_removes_full_id(self):
        stopped = dict(self.value, running=False)
        with patch.object(
            m,
            "run",
            side_effect=[
                self.response(self.name + "\n"),
                self.response(json.dumps(self.value)),
                self.response(""),
                self.response(json.dumps(stopped)),
                self.response(""),
            ],
        ) as run:
            m.remove_owned(self.name, self.purpose)
            self.assertEqual(
                run.call_args_list[2].args[0],
                ["docker", "stop", "--time", "95", "a" * 64],
            )
            self.assertEqual(run.call_args_list[-1].args[0], ["docker", "rm", "a" * 64])

    def test_unconfirmed_stop_preserves_container(self):
        with (
            patch.object(
                m,
                "run",
                side_effect=[
                    self.response(self.name + "\n"),
                    self.response(json.dumps(self.value)),
                    self.response(""),
                    self.response(json.dumps(self.value)),
                ],
            ) as run,
            self.assertRaises(ValueError),
        ):
            m.remove_owned(self.name, self.purpose)
        self.assertFalse(any(call.args[0][1] == "rm" for call in run.call_args_list))

    def test_helper_creation_has_separate_owner_label(self):
        source = Path(m.__file__).read_text()
        self.assertIn('"axiom.purpose=local-key-service-stage"', source)
        self.assertNotIn('"rm", "-f"', source)


if __name__ == "__main__":
    unittest.main()


class ImagePinTests(unittest.TestCase):
    def setUp(self):
        self.image = "sha256:" + "b" * 64
        self.name = "axiom-key-service-kosha"
        self.value = {
            "id": "a" * 64,
            "name": "/" + self.name,
            "image": self.image,
            "labels": {"axiom.purpose": "local-key-service"},
        }

    def response(self, value):
        return subprocess.CompletedProcess([], 0, value, "")

    def test_existing_image_survives_old_bff_and_is_checked_before_remove(self):
        with (
            patch.object(
                m,
                "run",
                side_effect=[
                    self.response(self.name),
                    self.response(json.dumps(self.value)),
                    self.response(self.image),
                    self.response("started"),
                ],
            ) as run,
            patch.object(m, "remove_owned") as remove,
        ):
            m.container("kosha", "--serve", True)
            remove.assert_called_once_with(self.name, "local-key-service")
            args = run.call_args_list[-1].args[0]
            self.assertIn(self.image, args)
            self.assertFalse(
                any("{{.Config.Image}}" in call.args[0] for call in run.call_args_list)
            )

    def test_initial_deployment_requires_explicit_immutable_pin(self):
        for candidate in (None, "some:tag", "sha256:" + "G" * 64):
            with patch.object(m, "run", return_value=self.response("")) as run:
                with self.assertRaises(ValueError):
                    m.service_image("kosha", candidate)
                self.assertEqual(run.call_count, 1)
        with patch.object(
            m, "run", side_effect=[self.response(""), self.response(self.image)]
        ):
            self.assertEqual(m.service_image("kosha", self.image), self.image)

    def test_foreign_collision_refused_even_with_explicit_upgrade(self):
        for changed in (
            {"labels": {}},
            {"labels": {"axiom.purpose": "foreign"}},
            {"name": "/foreign"},
            {"id": "short"},
        ):
            with patch.object(
                m,
                "run",
                side_effect=[
                    self.response(self.name),
                    self.response(json.dumps(dict(self.value, **changed))),
                ],
            ) as run:
                with self.assertRaises(ValueError):
                    m.service_image("kosha", self.image)
                self.assertEqual(run.call_count, 2)

    def test_unknown_image_or_unresolved_current_preserves_service(self):
        for image_response in (
            self.response("sha256:" + "c" * 64),
            subprocess.CalledProcessError(1, "docker"),
        ):
            with (
                patch.object(
                    m,
                    "run",
                    side_effect=[
                        self.response(self.name),
                        self.response(json.dumps(self.value)),
                        image_response,
                    ],
                ),
                patch.object(m, "remove_owned") as remove,
            ):
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    m.container("kosha", "--serve", True)
                remove.assert_not_called()
        with (
            patch.object(
                m,
                "run",
                side_effect=[
                    self.response(self.name),
                    self.response(json.dumps(dict(self.value, image="some:tag"))),
                ],
            ),
            self.assertRaises(ValueError),
        ):
            m.service_image("kosha", self.image)

    def test_reviewed_upgrade_uses_explicit_new_image(self):
        new = "sha256:" + "c" * 64
        with patch.object(
            m,
            "run",
            side_effect=[
                self.response(self.name),
                self.response(json.dumps(self.value)),
                self.response(new),
            ],
        ):
            self.assertEqual(m.service_image("kosha", new), new)


class RecoveryCreation(unittest.TestCase):
    def test_nonce_scoped_creation_requires_absent_name_and_never_removes_collision(self):
        nonce = "a" * 32
        image = "sha256:" + "b" * 64
        with patch.object(m, "service_image", return_value=image), patch.object(m, "run", return_value=subprocess.CompletedProcess([], 0, "axiom-key-service-kosha\n", "")) as execute, patch.object(m, "remove_owned") as remove:
            with self.assertRaisesRegex(ValueError, "absent"):
                m.container("kosha", "--serve", True, image, nonce)
            remove.assert_not_called()
            self.assertEqual(execute.call_count, 1)
        with patch.object(m, "service_image", return_value=image), patch.object(m, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as execute, patch.object(m, "remove_owned") as remove, patch("builtins.print"):
            m.container("kosha", "--serve", True, image, nonce)
            remove.assert_not_called()
            launch = execute.call_args.args[0]
            self.assertIn("axiom.recovery.owner=" + nonce, launch)
            self.assertIn(image, launch)
        for mode, detach, owner in (("--check", False, nonce), ("--serve", True, "invalid")):
            with self.subTest(mode=mode, owner=owner), self.assertRaises(ValueError):
                m.container("kosha", mode, detach, image, owner)
