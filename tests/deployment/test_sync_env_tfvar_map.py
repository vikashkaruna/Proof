"""`sync-env.sh` writes map-typed Terraform variables as HCL maps.

`cloud_sql_authorized_networks` is a map(string) whose value comes from a
.env line and lands inside a generated .tfvars file, so the renderer must
produce exactly one well-formed map or refuse; it must never pass through
anything that could close the string or add another assignment.
"""

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "sync-env.sh"


def literal(raw: str) -> subprocess.CompletedProcess:
    # Run only the function under test, without executing the script's actions.
    program = (
        # eval of the extracted text, not `source <(...)`: bash 3.2 (macOS) cannot
        # source a process substitution.
        f'eval "$(sed -n "/^tfvar_map_literal()/,/^}}/p" "{SCRIPT}")"; '
        'tfvar_map_literal "$1"'
    )
    return subprocess.run(
        ["bash", "-c", program, "bash", raw], capture_output=True, text=True, check=False
    )


class TfvarMapLiteralTests(unittest.TestCase):
    def test_empty_stays_private_only(self):
        result = literal("")
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "{}"))

    def test_named_cidrs_become_an_hcl_map(self):
        one = literal("runner=203.0.113.7/32")
        self.assertEqual(one.stdout.strip(), '{ "runner" = "203.0.113.7/32" }')
        two = literal("a-1=203.0.113.7/32,b.2=198.51.100.9/32")
        self.assertEqual(
            two.stdout.strip(),
            '{ "a-1" = "203.0.113.7/32", "b.2" = "198.51.100.9/32" }',
        )

    def test_anything_that_could_escape_the_string_is_refused(self):
        for raw in (
            'x"=1.2.3.4/32',  # closes the quote
            'x=1.2.3.4/32"\nother = "y',  # injects a second assignment
            "x=1.2.3.4/32 # note",  # spaces / comment
            "x=$(id)",  # command substitution characters
            "no-equals-sign",
            "203.0.113.7",  # a bare address would otherwise be read as both name and value
            "=203.0.113.7/32",  # empty name
            "x=",  # empty cidr
            "x=203.0.113.7/32,",  # trailing separator leaves an empty pair
            "x\\y=203.0.113.7/32",  # backslash
        ):
            with self.subTest(raw=raw):
                result = literal(raw)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(result.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
