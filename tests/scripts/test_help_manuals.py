"""Release documentation drift and confidential-export boundary regressions."""
import importlib.util
import json
import re
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("help_manuals", ROOT / "scripts/help-manuals.py")
help_manuals = importlib.util.module_from_spec(spec)
spec.loader.exec_module(help_manuals)


class HelpManualTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("packages/types/src/rbac.ts", "packages/types/src/enums.ts"):
            self.put(name, (ROOT / name).read_text())
        self.put("apps/web/src/app/(app)/dashboard/page.tsx", "export default function Dashboard() {}\n")
        self.put("apps/marketing/src/app/contact/page.tsx", "export default function Contact() {}\n")
        self.put("apps/web/src/app/(app)/nav.ts", "export const APP_NAV_GROUPS = [{route: '/dashboard', en: 'Dashboard', capability: Capability.POSTURE_READ}];\n")
        for name in ("scripts/axiom-ops.sh", "scripts/sync-env.sh", "scripts/dev-docker.sh",
                     "scripts/deploy-preprod-gcp.sh", "scripts/run-deployed-acceptance.sh",
                     "scripts/help-manuals.py", ".github/workflows/help-manuals.yml",
                     "scripts/check-private-docs.sh",
                     "private-docs/reference/02_Phase_Wise_Implementation_Plan.md", "private-docs/reference/03_BRD_PRD.md"):
            self.put(name, "reviewed fixture\n")
        for name in help_manuals.ASSETS:
            self.put("private-docs/help/assets/" + name, '<svg xmlns="http://www.w3.org/2000/svg"><title>Illustrative screen</title><text>Fictional example</text></svg>\n')
        self.put(help_manuals.MANUALS["founder"], "# PRIVATE FOUNDER MANUAL\n\nPrivate controls: never share this document.\n", private=True)
        self.put(help_manuals.PRIVATE_TESTING, "# Private test procedure\n\nAll cases not_run.\n", private=True)
        for audience in ("client", "partner"):
            self.put(help_manuals.MANUALS[audience], '# User guide\n\nRead [Dashboard](/dashboard). Assigned scope still applies.\n\n![Fictional illustration](../assets/dashboard.svg)\n')
        cases = {"schemaVersion": 1, "cases": [self.case("CASE-1", "/dashboard"), self.case("CASE-2", "marketing:/contact")]}
        self.put(help_manuals.CASES, json.dumps(cases), private=True)
        (self.root / "private-docs").chmod(0o700)
        help_manuals.sync(self.root, "Reviewed all test fixtures and confidential boundaries")

    def put(self, relative, text, private=False):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if private:
            path.parent.chmod(0o700)
        path.write_text(text)
        if private:
            path.chmod(0o600)
        return path

    @staticmethod
    def case(case_id, route):
        return {"id": case_id, "title": "Inspect selected scope", "routes": [route],
                "personas": ["owner"], "requirementRefs": ["NFR-2"], "availability": "current",
                "preconditions": ["Approved fictional organization"], "steps": ["Open the selected view"],
                "expected": ["Only selected records are shown"], "evidence": ["Sanitized outcome"], "destructive": False}

    def test_current_docs_and_private_receipts_pass(self):
        outcome = help_manuals.check(self.root, require_private=True)
        self.assertEqual(outcome["routes"], 2)
        self.assertTrue(outcome["privateChecked"])

    def test_sync_preserves_formatted_tables_and_detects_content_changes(self):
        path = self.root / help_manuals.MANUALS["client"]
        formatted = re.sub(r"(?m)^\|[| :\-]+\|$",
                           lambda match: match[0].replace("---", "---------------------"),
                           path.read_text())
        path.write_text(formatted)
        help_manuals.sync(self.root, "Reviewed formatter changes without workflow changes")
        self.assertEqual(path.read_text(), formatted)
        help_manuals.check(self.root, require_private=True)
        path.write_text(formatted.replace("Dashboard", "Incorrect task name", 1))
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.check(self.root)

    def test_screen_change_requires_review_before_sharing(self):
        self.put("apps/web/src/app/(app)/dashboard/page.tsx", "changed user action\n")
        with self.assertRaisesRegex(help_manuals.HelpError, "Feature/config drift"):
            help_manuals.export(self.root, "client", self.root / "private-docs/help/share/review")

    def test_new_route_cannot_receive_a_review_receipt_without_cases(self):
        self.put("apps/web/src/app/(app)/new-feature/page.tsx", "new user feature\n")
        with self.assertRaisesRegex(help_manuals.HelpError, "Missing manual cases"):
            help_manuals.sync(self.root, "Reviewed feature without adding its required cases")

    def test_configuration_and_supporting_modules_require_manual_review(self):
        for path in ("packages/report-kit/src/render.ts", "packages/mfa/src/totp.ts",
                     "infra/terraform/envs/preprod/main.tf", "infra/helm/axiom-proof/values.yaml",
                     "apps/web/.env.example", "services/bff/.env.example", "docker-compose.yml"):
            with self.subTest(path=path):
                file = self.put(path, "Changed operational or user-facing behavior\n")
                with self.assertRaisesRegex(help_manuals.HelpError, "Feature/config drift"):
                    help_manuals.check(self.root)
                file.unlink()

    def test_removed_route_refuses_obsolete_test_cases(self):
        (self.root / "apps/marketing/src/app/contact/page.tsx").unlink()
        with self.assertRaisesRegex(help_manuals.HelpError, "Unknown case route"):
            help_manuals.sync(self.root, "Reviewed removed screen")

    def test_unknown_fields_and_duplicate_case_ids_are_refused(self):
        for modification in (lambda rows: rows[0].update({"executionStatus": "passed"}),
                             lambda rows: rows.append(dict(rows[0]))):
            with self.subTest(modification=modification):
                original = (self.root / help_manuals.CASES).read_text()
                data = json.loads(original); modification(data["cases"])
                self.put(help_manuals.CASES, json.dumps(data), private=True)
                with self.assertRaises(help_manuals.HelpError):
                    help_manuals.sync(self.root, "Reviewed malformed case suite")
                self.put(help_manuals.CASES, original, private=True)

    def test_navigation_label_is_updated_from_actual_source(self):
        self.put("apps/web/src/app/(app)/nav.ts", "const APP_NAV_GROUPS = [{route: '/dashboard', en: 'New overview label', capability: Capability.POSTURE_READ}];\n")
        help_manuals.sync(self.root, "Reviewed navigation label changes across manuals")
        for audience in ("client", "partner"):
            self.assertIn("New overview label", (self.root / help_manuals.MANUALS[audience]).read_text())
        help_manuals.check(self.root, require_private=True)

    def test_role_change_invalidates_review_and_updates_action_reference(self):
        path = self.root / "packages/types/src/rbac.ts"
        text = path.read_text().replace("[UserRole.PARTNER]: [", "[UserRole.PARTNER]: [\n    Capability.PLAN_APPROVE,")
        path.write_text(text)
        with self.assertRaisesRegex(help_manuals.HelpError, "Feature/config drift"):
            help_manuals.check(self.root)
        help_manuals.sync(self.root, "Reviewed changed partner role and updated its task guidance")
        partner = (self.root / help_manuals.MANUALS["partner"]).read_text()
        self.assertIn("| Approve within assigned scope | Eligible; conditions apply |", partner)

    def test_private_founder_cannot_be_exported(self):
        with self.assertRaisesRegex(help_manuals.HelpError, "Internal founder/QA"):
            help_manuals.export(self.root, "founder", self.root / "private-docs/help/share/review")

    def test_confidential_content_markers_are_refused(self):
        for marker in ("Terraform", "SUPABASE_SERVICE_KEY", "JWT", "https://private.run.app", "23_Operator_Runbook.md", "Founder Help Manual"):
            with self.subTest(marker=marker), self.assertRaises(help_manuals.HelpError):
                help_manuals.validate_external(self.root, "client", "Customer instructions: " + marker)

    def test_assigned_scope_is_valid_customer_language(self):
        help_manuals.validate_external(self.root, "client", "Approve within assigned scope.")

    def test_unapproved_links_and_private_parameters_are_refused(self):
        for target in ("../../23_Operator_Runbook.md", "javascript:alert(1)", "//private.example/path", "https://private.example/path", "/internal/founder", "/dashboard?secret=value", "/../private", "https://user:pass@app.axiomproof.ai/dashboard"):
            with self.subTest(target=target), self.assertRaises(help_manuals.HelpError):
                help_manuals.validate_external(self.root, "partner", f"[Help]({target})")

    def test_unapproved_or_active_illustrations_are_refused(self):
        for image in ("https://example.invalid/real-person.png", "../internal/screenshot.svg"):
            with self.subTest(image=image), self.assertRaises(help_manuals.HelpError):
                help_manuals.validate_external(self.root, "client", f"![Sample]({image})")
        for svg in ('<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>', '<svg><image href="https://example.invalid/pixel"/></svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]><svg/>', '<svg><text>real@customer.example</text></svg>'):
            with self.subTest(svg=svg):
                self.put("private-docs/help/assets/dashboard.svg", svg)
                with self.assertRaises(help_manuals.HelpError):
                    help_manuals.approved_svg(self.root, "dashboard.svg")

    def test_symlinked_external_source_is_refused(self):
        path = self.root / help_manuals.MANUALS["client"]
        path.unlink(); path.symlink_to(self.root / help_manuals.MANUALS["founder"])
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.export(self.root, "client", self.root / "private-docs/help/share/review")

    def test_exports_are_offline_and_never_include_private_documents(self):
        output = self.root / "private-docs/help/share/review"
        path = help_manuals.export(self.root, "client", output)
        page = path.read_text()
        self.assertIn("data:image/svg+xml;base64,", page)
        self.assertIn("https://app.axiomproof.ai/dashboard", page)
        self.assertNotIn("PRIVATE FOUNDER MANUAL", page)
        self.assertNotIn("Private test procedure", page)
        self.assertNotIn("<script", page)
        self.assertEqual([p.name for p in output.iterdir()], ["client-help.html"])
        self.assertEqual(path.stat().st_mode & 0o077, 0)

    def test_repository_exports_stay_in_the_ignored_share_folder(self):
        for relative in ("customer-help", "private-docs/reference/export", "private-docs/testing/export"):
            with self.subTest(relative=relative):
                with self.assertRaisesRegex(help_manuals.HelpError, "ignored private-docs/help/share"):
                    help_manuals.export(self.root, "client", self.root / relative)

    def test_missing_private_pack_cannot_be_checked_or_exported(self):
        (self.root / "private-docs").rename(self.root / "backup")
        with self.assertRaisesRegex(help_manuals.HelpError, "folder is missing"):
            help_manuals.check(self.root)
        with self.assertRaisesRegex(help_manuals.HelpError, "folder is missing"):
            help_manuals.export(self.root, "client", self.root / "private-docs/help/share/review")

    def test_private_pack_permissions_are_required_for_external_exports(self):
        (self.root / "private-docs").chmod(0o755)
        with self.assertRaisesRegex(help_manuals.HelpError, "lacks private permissions"):
            help_manuals.export(self.root, "client", self.root / "private-docs/help/share/review")

    def test_source_or_nonempty_share_output_is_refused(self):
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.export(self.root, "client", self.root / "apps/public")
        output = self.root / "private-docs/help/share/review"; output.mkdir(parents=True); (output / "private-note.md").write_text("private")
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.export(self.root, "client", output)

    def test_symlink_share_output_is_refused(self):
        dest = self.root / "destination"; dest.mkdir()
        link = self.root / "private-docs/help/share/review"; link.parent.mkdir(parents=True, exist_ok=True); link.symlink_to(dest, target_is_directory=True)
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.export(self.root, "client", link)

    def test_external_pack_can_check_without_internal_prose(self):
        for name in (help_manuals.MANUALS["founder"], help_manuals.PRIVATE_TESTING, help_manuals.CASES):
            (self.root / name).unlink()
        self.assertFalse(help_manuals.check(self.root)["privateChecked"])
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.check(self.root, require_private=True)

    def test_public_internal_directory_is_never_a_confidentiality_boundary(self):
        self.put("docs/help/internal/founder.md", "private owner instructions")
        with self.assertRaisesRegex(help_manuals.HelpError, "protected ignored"):
            help_manuals.check(self.root)

    def test_private_change_needs_review_and_private_permissions(self):
        path = self.root / help_manuals.MANUALS["founder"]
        path.write_text(path.read_text() + "\nChanged internal instructions.\n")
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.check(self.root, require_private=True)
        help_manuals.sync(self.root, "Reviewed internal instructions and source readiness")
        path.chmod(0o644)
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.check(self.root, require_private=True)
        path.chmod(0o600)
        path.parent.chmod(0o755)
        with self.assertRaisesRegex(help_manuals.HelpError, "directory lacks private permissions"):
            help_manuals.check(self.root, require_private=True)

    def test_public_coverage_cannot_include_private_steps(self):
        path = self.root / help_manuals.COVERAGE
        data = json.loads(path.read_text()); data["cases"][0]["steps"] = ["private detail"]
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(help_manuals.HelpError, "Private content"):
            help_manuals.check(self.root)

    def test_meaningful_review_reason_is_required(self):
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.sync(self.root, "ok")

    def test_raw_html_is_escaped_even_without_javascript(self):
        rendered = help_manuals.markdown_html(self.root, '<img src=x onerror="alert(1)">')
        self.assertNotIn("<img", rendered)
        self.assertIn("&lt;img", rendered)


if __name__ == "__main__":
    unittest.main()
