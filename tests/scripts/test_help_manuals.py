"""Release documentation drift and confidential-export boundary regressions."""
import importlib.util
import json
import re
import shutil
import subprocess
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
                     "docs/private-plans/PLAN-02-phase-wise-implementation.md", "docs/private-docs/requirements/REQ-01-brd-prd.md"):
            self.put(name, "reviewed fixture\n")
        for name in help_manuals.ASSETS:
            self.put("docs/private-docs/help/assets/" + name, '<svg xmlns="http://www.w3.org/2000/svg"><title>Illustrative screen</title><text>Fictional example</text></svg>\n')
        self.put(help_manuals.MANUALS["founder"], "# PRIVATE FOUNDER MANUAL\n\nPrivate controls: never share this document.\n", private=True)
        self.put(help_manuals.PRIVATE_TESTING, "# Private test procedure\n\nAll cases not_run.\n", private=True)
        for audience in ("client", "partner"):
            self.put(help_manuals.MANUALS[audience], '# User guide\n\nRead [Dashboard](/dashboard). Assigned scope still applies.\n\n![Fictional illustration](assets/dashboard.svg)\n')
        cases = {"schemaVersion": 1, "cases": [self.case("CASE-1", "/dashboard"), self.case("CASE-2", "marketing:/contact")]}
        self.put(help_manuals.CASES, json.dumps(cases), private=True)
        (self.root / "docs/private-docs").chmod(0o700)
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
            help_manuals.export(self.root, "client", self.root / "docs/private-docs/help/share/review")

    def test_new_route_cannot_receive_a_review_receipt_without_cases(self):
        self.put("apps/web/src/app/(app)/new-feature/page.tsx", "new user feature\n")
        with self.assertRaisesRegex(help_manuals.HelpError, "Missing manual cases"):
            help_manuals.sync(self.root, "Reviewed feature without adding its required cases")

    def test_configuration_and_supporting_modules_require_manual_review(self):
        for path in ("packages/report-kit/src/render.ts", "packages/mfa/src/totp.ts",
                     "infra/terraform/envs/preprod/main.tf", "infra/helm/axiom-proof/values.yaml",
                     "apps/web/.env.example", "services/bff/.env.example", "docker-compose.yml",
                     ".dockerignore", "services/agent-runtime/pyproject.toml"):
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
            help_manuals.export(self.root, "founder", self.root / "docs/private-docs/help/share/review")

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
                self.put("docs/private-docs/help/assets/dashboard.svg", svg)
                with self.assertRaises(help_manuals.HelpError):
                    help_manuals.approved_svg(self.root, "dashboard.svg")

    def test_symlinked_external_source_is_refused(self):
        path = self.root / help_manuals.MANUALS["client"]
        path.unlink(); path.symlink_to(self.root / help_manuals.MANUALS["founder"])
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.export(self.root, "client", self.root / "docs/private-docs/help/share/review")

    def test_exports_are_offline_and_never_include_private_documents(self):
        output = self.root / "docs/private-docs/help/share/review"
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
        for relative in ("customer-help", "docs/private-docs/reference/export", "docs/private-docs/testing/export"):
            with self.subTest(relative=relative):
                with self.assertRaisesRegex(help_manuals.HelpError, "ignored docs/private-docs/help/share"):
                    help_manuals.export(self.root, "client", self.root / relative)

    def test_missing_private_pack_cannot_be_checked_or_exported(self):
        (self.root / "docs/private-docs").rename(self.root / "backup")
        with self.assertRaisesRegex(help_manuals.HelpError, "folder is missing"):
            help_manuals.check(self.root)
        with self.assertRaisesRegex(help_manuals.HelpError, "folder is missing"):
            help_manuals.export(self.root, "client", self.root / "docs/private-docs/help/share/review")

    def test_private_pack_permissions_are_required_for_external_exports(self):
        (self.root / "docs/private-docs").chmod(0o755)
        with self.assertRaisesRegex(help_manuals.HelpError, "lacks private permissions"):
            help_manuals.export(self.root, "client", self.root / "docs/private-docs/help/share/review")

    def test_source_or_nonempty_share_output_is_refused(self):
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.export(self.root, "client", self.root / "apps/public")
        output = self.root / "docs/private-docs/help/share/review"; output.mkdir(parents=True); (output / "private-note.md").write_text("private")
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.export(self.root, "client", output)

    def test_symlink_share_output_is_refused(self):
        dest = self.root / "destination"; dest.mkdir()
        link = self.root / "docs/private-docs/help/share/review"; link.parent.mkdir(parents=True, exist_ok=True); link.symlink_to(dest, target_is_directory=True)
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


class TwoRootHelpTests(unittest.TestCase):
    setUp = HelpManualTests.setUp
    put = HelpManualTests.put
    case = staticmethod(HelpManualTests.case)

    def separate_source(self, versioned=False):
        release = tempfile.TemporaryDirectory()
        self.addCleanup(release.cleanup)
        source = Path(release.name)
        shutil.copytree(self.root, source, dirs_exist_ok=True)
        shutil.rmtree(source / "docs")
        if versioned:
            for args in (("init",), ("config", "user.email", "fixture@example.invalid"),
                         ("config", "user.name", "Fixture"), ("add", "."),
                         ("commit", "-m", "Fictional source")):
                subprocess.run(["git", "-C", str(source), *args], check=True,
                               capture_output=True, text=True)
        return source

    def test_separate_roots_read_source_and_write_only_canonical_docs(self):
        source = self.separate_source(versioned=True)
        # An unrelated route in the docs checkout must never supply release navigation.
        self.put("apps/web/src/app/(app)/unreleased/page.tsx", "draft unrelated route")
        result = help_manuals.sync(source, "Reviewed selected committed source and canonical prose", self.root, True)
        self.assertEqual(result["sourceBinding"]["watchStatus"], "clean_commit")
        self.assertEqual(len(result["sourceBinding"]["privateCompanions"]), 5)
        self.assertFalse((source / "docs").exists())
        self.assertEqual(help_manuals.check(source, True, self.root, True)["routes"], 2)
        self.assertEqual(help_manuals.main(["check", "--source-root", str(source),
                                           "--docs-root", str(self.root), "--require-clean-source",
                                           "--require-private"]), 0)

    def test_wrong_docs_root_refuses_without_private_fallback(self):
        source = self.separate_source()
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.sync(source, "Review cannot substitute missing canonical docs", source)
        self.assertFalse((source / "docs").exists())

    def test_wrong_source_root_cannot_use_docs_checkout_code(self):
        source = self.separate_source()
        (source / "packages/types/src/rbac.ts").unlink()
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.sync(source, "Missing source role map cannot fall back", self.root)

    def test_dirty_watch_is_explicit_and_cannot_claim_exact_commit(self):
        source = self.separate_source(versioned=True)
        target = source / "apps/web/src/app/(app)/dashboard/page.tsx"
        target.write_text(target.read_text() + "// changed released screen\n")
        result = help_manuals.sync(source, "Review of a draft, not exact source clearance", self.root)
        self.assertEqual(result["sourceBinding"]["watchStatus"], "draft_dirty")
        self.assertTrue(result["sourceBinding"]["watchedDirty"])
        with self.assertRaisesRegex(help_manuals.HelpError, "clean versioned"):
            help_manuals.check(source, True, self.root, True)

    def test_exact_commit_change_with_identical_tree_refuses(self):
        source = self.separate_source(versioned=True)
        help_manuals.sync(source, "Reviewed exact initial source commit identity", self.root, True)
        subprocess.run(["git", "-C", str(source), "commit", "--allow-empty", "-m", "Different commit"],
                       check=True, capture_output=True)
        with self.assertRaisesRegex(help_manuals.HelpError, "commit/tree"):
            help_manuals.check(source, True, self.root, True)

    def test_unversioned_fixture_never_claims_release_clearance(self):
        source = self.separate_source()
        result = help_manuals.sync(source, "Review of explicitly unversioned fictional source", self.root)
        self.assertEqual(result["sourceBinding"]["watchStatus"], "unversioned")
        self.assertIsNone(result["sourceBinding"]["commit"])
        with self.assertRaisesRegex(help_manuals.HelpError, "clean versioned"):
            help_manuals.sync(source, "Exact source requested without version evidence", self.root, True)

    def test_check_detects_drift_without_silent_sync(self):
        source = self.separate_source()
        help_manuals.sync(source, "Reviewed initial source with independent canonical docs", self.root)
        originals = {name: (self.root / name).read_bytes()
                     for name in (*help_manuals.MANUALS.values(), help_manuals.INDEX, help_manuals.COVERAGE)}
        (source / "apps/web/src/app/(app)/dashboard/page.tsx").write_text("changed release screen")
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.check(source, True, self.root)
        self.assertEqual(originals, {name: (self.root / name).read_bytes() for name in originals})

    def test_release_workflow_and_three_python_locks_are_watched(self):
        source = self.separate_source()
        paths = [".github/workflows/ci.yml", *[f"services/{service}/uv.lock" for service in
                 ("agent-runtime", "model-gateway", "temporal-workers")]]
        for name in paths:
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("original fictional reviewed policy")
        for name in paths:
            with self.subTest(path=name):
                result = help_manuals.sync(source, "Reviewed release workflow and locked image source", self.root)
                self.assertIn(name, result["sources"])
                target = source / name
                target.write_text(target.read_text() + "changed")
                with self.assertRaises(help_manuals.HelpError):
                    help_manuals.check(source, True, self.root)

    def test_private_parent_symlink_refuses_before_any_sync_write(self):
        source = self.separate_source()
        manual_before = (self.root / help_manuals.MANUALS["client"]).read_bytes()
        index = self.root / help_manuals.INDEX
        index.unlink()
        outside = source / "outside-index.json"
        outside.write_text("do not overwrite")
        index.symlink_to(outside)
        with self.assertRaisesRegex(help_manuals.HelpError, "Symlinks"):
            help_manuals.sync(source, "Must refuse symlink target without partial mutation", self.root)
        self.assertEqual((self.root / help_manuals.MANUALS["client"]).read_bytes(), manual_before)
        self.assertEqual(outside.read_text(), "do not overwrite")

    def test_lexical_escape_and_in_root_parent_symlink_refused(self):
        for name in ("../outside", "/absolute"):
            with self.assertRaises(help_manuals.HelpError):
                help_manuals.safe_file(self.root, name)
        alias = self.root / "alias"
        alias.symlink_to(self.root / "docs/private-docs", target_is_directory=True)
        with self.assertRaisesRegex(help_manuals.HelpError, "Symlinks"):
            help_manuals.safe_file(self.root, "alias/help/HELP-client-manual.md")

    def test_source_watch_directory_symlink_refused(self):
        source = self.separate_source()
        shutil.rmtree(source / "packages/types/src")
        (source / "packages/types/src").symlink_to(self.root / "packages/types/src", target_is_directory=True)
        with self.assertRaisesRegex(help_manuals.HelpError, "Symlinks"):
            help_manuals.sources(source, self.root)

    def test_legacy_single_root_receipt_cannot_claim_exact_source_review(self):
        index = self.root / help_manuals.INDEX
        stored = json.loads(index.read_text())
        del stored["sourceBinding"]
        index.write_text(json.dumps(stored))
        self.assertFalse(help_manuals.check(self.root, True)["exactSourceReviewed"])
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.check(self.root, True, self.root)

    def test_ignored_watched_source_is_dirty_even_when_git_status_default_hides_it(self):
        source = self.separate_source(versioned=True)
        (source / ".git/info/exclude").write_text("apps/web/src/ignored.ts\n")
        (source / "apps/web/src/ignored.ts").write_text("unpublished ignored source")
        result = help_manuals.sync(source, "Explicit draft includes ignored source differences", self.root)
        self.assertEqual(result["sourceBinding"]["watchStatus"], "draft_dirty")
        with self.assertRaises(help_manuals.HelpError):
            help_manuals.check(source, True, self.root, True)

    def test_deleted_tracked_watched_files_refuse_clean_sync_before_any_write(self):
        for name in ("services/bff/src/retained-service.ts", "services/agent-runtime/uv.lock"):
            with self.subTest(path=name):
                source = self.separate_source(versioned=True)
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("committed source configuration")
                subprocess.run(["git", "-C", str(source), "add", name], check=True, capture_output=True)
                subprocess.run(["git", "-C", str(source), "commit", "-m", "Retain watched source"], check=True, capture_output=True)
                help_manuals.sync(source, "Reviewed committed complete source before deletion", self.root, True)
                originals = {n: (self.root / n).read_bytes() for n in
                             (*help_manuals.MANUALS.values(), help_manuals.INDEX, help_manuals.COVERAGE)}
                target.unlink()
                with self.assertRaisesRegex(help_manuals.HelpError, "clean versioned"):
                    help_manuals.sync(source, "Deletion cannot be declared an exact commit review", self.root, True)
                self.assertEqual(originals, {n: (self.root / n).read_bytes() for n in originals})

    def test_nested_symlink_cannot_disappear_and_claim_clean_inventory(self):
        source = self.separate_source(versioned=True)
        alias = source / "apps/web/src/hidden-source"
        alias.symlink_to(self.root / "apps/web/src", target_is_directory=True)
        originals = {n: (self.root / n).read_bytes() for n in
                     (*help_manuals.MANUALS.values(), help_manuals.INDEX, help_manuals.COVERAGE)}
        with self.assertRaisesRegex(help_manuals.HelpError, "Symlink"):
            help_manuals.sync(source, "Nested link cannot silently remove source from review", self.root, True)
        self.assertEqual(originals, {n: (self.root / n).read_bytes() for n in originals})

    def test_deleted_caches_and_private_docs_do_not_dirty_release_watch(self):
        source = self.separate_source(versioned=True)
        names = ("apps/web/src/node_modules/cache.py", "services/bff/src/coverage/cache.ts",
                 "services/bff/src/tests/fixture.ts", "docs/private-docs/private.md")
        for name in names:
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("excluded fictional content")
            subprocess.run(["git", "-C", str(source), "add", name], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(source), "commit", "-m", "Excluded fictional fixtures"], check=True, capture_output=True)
        for name in names:
            (source / name).unlink()
        cache_link = source / "apps/web/src/node_modules/alias"
        cache_link.symlink_to(self.root / "docs/private-docs", target_is_directory=True)
        result = help_manuals.sync(source, "Excluded caches and private docs are not release source", self.root, True)
        self.assertEqual(result["sourceBinding"]["watchStatus"], "clean_commit")

    def test_dangling_optional_lock_symlink_refused_before_sync(self):
        source = self.separate_source(versioned=True)
        target = source / "services/model-gateway/uv.lock"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(source / "missing-lock")
        original = (self.root / help_manuals.INDEX).read_bytes()
        with self.assertRaisesRegex(help_manuals.HelpError, "Symlink"):
            help_manuals.sync(source, "Missing optional lock link cannot evade source boundary", self.root, True)
        self.assertEqual((self.root / help_manuals.INDEX).read_bytes(), original)

    def test_hidden_git_watch_flags_cannot_claim_exact_source(self):
        for flag in ("--assume-unchanged", "--skip-worktree"):
            with self.subTest(flag=flag):
                source = self.separate_source(versioned=True)
                name = "apps/web/src/app/(app)/dashboard/page.tsx"
                subprocess.run(["git", "-C", str(source), "update-index", flag, name], check=True, capture_output=True)
                (source / name).write_text("hidden changed source")
                with self.assertRaisesRegex(help_manuals.HelpError, "clean versioned"):
                    help_manuals.sync(source, "Git-hidden changes cannot become exact release review", self.root, True)


if __name__ == "__main__":
    unittest.main()
