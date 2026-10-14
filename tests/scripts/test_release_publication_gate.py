"""Registry publication must wait for every CI gate; stdlib-only source graph tests."""

import re
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
KNOWN_JOBS = frozenset(
    (
        "deployed-http-acceptance",
        "python-image-lock-parity",
        "evidence-storage",
        "workload-identity",
        "workload-host",
        "workload-runner-host",
        "database-security",
        "prativedan-assessment-interoperability",
        "prativedan-assessment-controller-interoperability",
        "strict-auth-parity",
        "persona-journeys",
        "env-security-gate",
        "tfvars-coverage-gate",
        "helm-render",
        "selfhosted-supabase",
        "control-count-gate",
        "control-library-drift-gate",
        "lint-and-typecheck",
        "test-ts",
        "coverage-ts",
        "sql-binding",
        "w9-performance-probe",
        "mysql-binding",
        "test-python-runtime",
        "test-python-temporal",
        "test-python-gateway",
        "security",
        "build-images",
    )
)
MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'"


def job_blocks(source):
    """Parse the workflow's block-style job IDs without loading untrusted YAML tags."""
    if source.count("\njobs:\n") != 1:
        raise ValueError("Expected exactly one block-style jobs section")
    jobs = {}
    current = None
    for line in source.split("\njobs:\n", 1)[1].splitlines():
        if line and not line.startswith((" ", "#")):
            raise ValueError("Unsupported top-level content after jobs")
        match = re.fullmatch(r"  ([a-z][a-z0-9-]*):", line)
        if match:
            current = match.group(1)
            if current in jobs:
                raise ValueError("Duplicate job")
            jobs[current] = []
        elif current is not None:
            jobs[current].append(line)
    return jobs


def property_value(block, name):
    prefix = "    " + name + ":"
    matches = [i for i, line in enumerate(block) if line.startswith(prefix)]
    if len(matches) > 1:
        raise ValueError("Duplicate job property")
    if not matches:
        return None
    index = matches[0]
    pieces = [block[index][len(prefix) :].strip()]
    for line in block[index + 1 :]:
        if line.strip() and not line.startswith("      "):
            break
        if line.strip() and not line.lstrip().startswith("#"):
            pieces.append(line.strip())
    return " ".join(pieces).strip()


def dependencies(block):
    value = property_value(block, "needs")
    if value is None:
        return ()
    if value.startswith("[") and value.endswith("]"):
        parts = [part.strip() for part in value[1:-1].split(",") if part.strip()]
    elif re.fullmatch(r"[a-z][a-z0-9-]*", value):
        parts = [value]
    else:
        raise ValueError("Unsupported needs syntax; review graph parser")
    if any(not re.fullmatch(r"[a-z][a-z0-9-]*", part) for part in parts):
        raise ValueError("Invalid dependency identity")
    if len(set(parts)) != len(parts):
        raise ValueError("Duplicate dependency")
    return tuple(parts)


def validate_publication_gate(source):
    jobs = job_blocks(source)
    if set(jobs) != KNOWN_JOBS:
        raise ValueError("CI job inventory changed; review all publication gates")
    graph = {name: dependencies(block) for name, block in jobs.items()}
    for name, needs in graph.items():
        if name in needs:
            raise ValueError("Self dependency")
        if any(need not in jobs for need in needs):
            raise ValueError("Missing dependency job")
    visiting, visited = set(), set()

    def visit(name):
        if name in visiting:
            raise ValueError("Dependency cycle")
        if name in visited:
            return
        visiting.add(name)
        for need in graph[name]:
            visit(need)
        visiting.remove(name)
        visited.add(name)

    for name in jobs:
        visit(name)
    if set(graph["build-images"]) != set(jobs) - {"build-images"}:
        raise ValueError("Publication must directly require all 27 other CI jobs")
    if property_value(jobs["build-images"], "if") != MAIN_PUSH:
        raise ValueError(
            "Publication must preserve main push and implicit success guard"
        )
    if property_value(jobs["build-images"], "continue-on-error") is not None:
        raise ValueError("Publication cannot waive errors")
    return graph


class ReleasePublicationGateTests(unittest.TestCase):
    def setUp(self):
        self.source = WORKFLOW.read_text()

    def test_all_known_jobs_required_without_missing_edges_or_cycles(self):
        graph = validate_publication_gate(self.source)
        self.assertEqual(len(graph), 28)
        self.assertEqual(len(graph["build-images"]), 27)

    def without_publication_dependency(self, name):
        before, after = self.source.split("  build-images:\n", 1)
        target = "        " + name + ",\n"
        self.assertIn(target, after)
        return before + "  build-images:\n" + after.replace(target, "", 1)

    def test_missing_w8_browser_gate_refuses_publication(self):
        with self.assertRaisesRegex(ValueError, "all 27"):
            validate_publication_gate(
                self.without_publication_dependency("evidence-storage")
            )

    def test_missing_security_gate_refuses_publication(self):
        with self.assertRaisesRegex(ValueError, "all 27"):
            validate_publication_gate(self.without_publication_dependency("security"))

    def test_missing_coverage_gate_refuses_publication(self):
        with self.assertRaisesRegex(ValueError, "all 27"):
            validate_publication_gate(
                self.without_publication_dependency("coverage-ts")
            )

    def test_unknown_dependency_is_not_a_gate(self):
        before, after = self.source.split("  build-images:\n", 1)
        changed = (
            before
            + "  build-images:\n"
            + after.replace("        test-ts,", "        missing-job,", 1)
        )
        with self.assertRaisesRegex(ValueError, "Missing dependency"):
            validate_publication_gate(changed)

    def test_self_dependency_is_rejected(self):
        # Replace the original property, rather than allowing a duplicate YAML key.
        block = job_blocks(self.source)["build-images"]
        old = (
            "    needs:\n"
            + "\n".join(
                block[
                    block.index("    needs:") + 1 : block.index("    if: " + MAIN_PUSH)
                ]
            )
            + "\n"
        )
        changed = self.source.replace(old, "    needs: build-images\n", 1)
        with self.assertRaisesRegex(ValueError, "Self dependency"):
            validate_publication_gate(changed)

    def test_upstream_dependency_on_publication_creates_cycle(self):
        changed = self.source.replace(
            "    needs: lint-and-typecheck", "    needs: build-images", 1
        )
        with self.assertRaisesRegex(ValueError, "cycle"):
            validate_publication_gate(changed)

    def test_new_gate_requires_inventory_and_fan_in_review(self):
        with self.assertRaisesRegex(ValueError, "inventory"):
            validate_publication_gate(
                self.source + "\n  new-release-gate:\n    runs-on: ubuntu-latest\n"
            )

    def test_always_or_main_predicate_waiver_refused(self):
        for condition in (
            "always() && " + MAIN_PUSH,
            "github.ref == 'refs/heads/main'",
            "success() || " + MAIN_PUSH,
        ):
            with (
                self.subTest(condition=condition),
                self.assertRaisesRegex(ValueError, "implicit success"),
            ):
                validate_publication_gate(
                    self.source.replace("    if: " + MAIN_PUSH, "    if: " + condition)
                )

    def test_publication_error_waiver_refused(self):
        changed = self.source.replace(
            "  build-images:\n", "  build-images:\n    continue-on-error: true\n", 1
        )
        with self.assertRaisesRegex(ValueError, "waive errors"):
            validate_publication_gate(changed)

    def test_duplicate_needs_property_refused(self):
        changed = self.source.replace(
            "  build-images:\n", "  build-images:\n    needs: security\n", 1
        )
        with self.assertRaisesRegex(ValueError, "Duplicate job property"):
            validate_publication_gate(changed)

    def test_duplicate_job_and_dependency_refused(self):
        with self.assertRaisesRegex(ValueError, "Duplicate job"):
            validate_publication_gate(
                self.source + "\n  security:\n    runs-on: ubuntu-latest\n"
            )
        before, after = self.source.split("  build-images:\n", 1)
        changed = (
            before
            + "  build-images:\n"
            + after.replace("        test-ts,", "        test-ts,\n        test-ts,", 1)
        )
        with self.assertRaisesRegex(ValueError, "Duplicate dependency"):
            validate_publication_gate(changed)


if __name__ == "__main__":
    unittest.main()
