#!/usr/bin/env python3
"""Keep persona manuals traceable; export only reviewed external audiences.

No network, credentials, application writes or third-party renderer required.
Source changes require a documented content review; navigation/action appendices
are generated, while prose and screenshots never get invented automatically.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
# Local SVGs reject DTD/entities and use a strict element allowlist.
import xml.etree.ElementTree as ET  # nosec B405

ROOT = Path(__file__).resolve().parents[1]
MANUALS = {
    "founder": "private-docs/help/internal/founder.md",
    "partner": "private-docs/help/external/partner.md",
    "client": "private-docs/help/external/client.md",
}
INDEX = "private-docs/help/maintenance/source-index.json"
CASES = "private-docs/testing/manual-test-cases.json"
PRIVATE_TESTING = "private-docs/testing/manual-testing.md"
COVERAGE = "private-docs/help/maintenance/manual-coverage.json"
ASSETS = ("dashboard.svg", "workflow.svg", "members.svg")
BEGIN = "<!-- BEGIN GENERATED HELP REFERENCE -->"
END = "<!-- END GENERATED HELP REFERENCE -->"
WATCH = (
    "apps/web/src", "apps/marketing/src", "services/bff/src",
    "services/agent-runtime/src", "services/model-gateway/src",
    "services/temporal-workers/src", "packages/types/src", "packages/config/src",
    "packages/ui/src", "packages/design-tokens/src", "packages/control-library/src",
    "packages/approval-engine/src", "packages/evidence/src", "packages/ledger/src",
    "packages/supabase/src", "packages/mfa/src", "packages/report-kit/src",
    "infra/supabase/migrations", "infra/docker", "infra/helm/axiom-proof",
    "infra/terraform", "infra/workload", "scripts/lib",
)
ACTION_LABELS = {
    "POSTURE_READ": "Read organization posture",
    "ENGAGEMENT_CREATE": "Create engagements",
    "ESTATE_MANAGE": "Manage organization estate",
    "USER_MANAGE": "Manage members and invitations",
    "TENANT_SETTINGS_WRITE": "Change organization settings",
    "ASSESSMENT_RUN": "Review or run permitted assessment work",
    "AGENT_INVOKE": "Request enabled agent work",
    "PLAN_CREATE": "Prepare remediation plans",
    "PLAN_COMMENT": "Comment on readable plans",
    "PLAN_APPROVE": "Approve within assigned scope",
    "PLAN_REJECT": "Reject plans",
    "PLAN_EXECUTE": "Execute authorized enabled actions",
    "EXECUTION_RECONCILE": "Resolve unconfirmed executions",
    "KILL_SWITCH_ENGAGE_TENANT": "Request an organization emergency stop",
    "KILL_SWITCH_RELEASE_TENANT": "Release an organization emergency stop",
    "REPORT_GENERATE": "Request supported working reports",
    "REPORT_REVIEW": "Review restricted report releases",
    "REPORT_RELEASE": "Release restricted reports",
    "EVIDENCE_RECORD": "Record authorized evidence",
    "EVIDENCE_EXPORT": "Export permitted evidence",
    "LEDGER_READ": "Read the audit history",
    "BILLING_MANAGE": "Manage organization billing where enabled",
}
FORBIDDEN = re.compile(
    r"(?i)(?:architecture|database|terraform|postgrest|supabase|cloud\s*run|kubernetes|eks\b|"
    r"security\s+definer|service[-_ ]role|jwt\b|spiffe|spire\b|"
    r"append_ledger|\bsigned[- ](?:scope|token)|hash[- ]chain|"
    r"private-docs|\.axiom-runtime|\.env\b|localhost|127\.0\.0\.1|"
    r"(?:postgres|postgresql)://|run\.app|chore/|infra/|services/|"
    r"[A-Z][A-Z0-9]+_[A-Z0-9_]+|\b[a-f0-9]{40,64}\b|"
    r"migration\s*0\d{3}|founder\.md|founder help|internal.only|manual-testing|source-index|"
    r"(?:20_Plan|21_Progress|22_Architecture|23_Operator))"
)


class HelpError(ValueError):
    pass


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_file(root: Path, relative: str) -> Path:
    path = root / relative
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise HelpError(f"Expected an in-repository regular file: {relative}")
    return path


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/|//[^\n]*", "", text, flags=re.S)


def inventory(root: Path) -> dict:
    routes = []
    for app in ("web", "marketing"):
        for path in sorted((root / f"apps/{app}/src/app").rglob("page.tsx")):
            parts = path.relative_to(root / f"apps/{app}/src/app").parts[:-1]
            if any(p.startswith("@") or p.startswith("(.)") for p in parts):
                raise HelpError("New parallel/intercepted route requires a reviewed inventory adapter")
            route = "/" + "/".join(p for p in parts if not p.startswith("("))
            routes.append({"route": route if app == "web" else f"marketing:{route}",
                           "source": path.relative_to(root).as_posix()})
    enum = strip_comments(safe_file(root, "packages/types/src/enums.ts").read_text())
    role_block = re.search(r"export const UserRole = \{(.*?)\} as const", enum, re.S)
    if not role_block:
        raise HelpError("Role source format changed")
    roles = dict(re.findall(r"([A-Z_]+):\s*'([a-z_]+)'", role_block[1]))
    rb = strip_comments(safe_file(root, "packages/types/src/rbac.ts").read_text())
    matrix_block = re.search(r"const MATRIX:.*?= \{(.*?)\n\};", rb, re.S)
    if not matrix_block:
        raise HelpError("Permission source format changed")
    matrix = {key: re.findall(r"Capability\.([A-Z_]+)", value) for key, value in
              re.findall(r"\[UserRole\.([A-Z_]+)\]:\s*\[(.*?)\]", matrix_block[1], re.S)}
    if set(matrix) != set(roles):
        raise HelpError("Role coverage differs from authoritative permission matrix")
    nav_source = strip_comments(safe_file(root, "apps/web/src/app/(app)/nav.ts").read_text())
    nav = []
    for block in re.findall(r"\{([^{}]*?route:\s*'[^']+'[^{}]*?)\}", nav_source, re.S):
        values = {key: re.search(rf"\b{key}:\s*'([^']+)'", block) for key in ("route", "en")}
        cap = re.search(r"capability:\s*Capability\.([A-Z_]+)", block)
        if not all(values.values()) or not cap:
            raise HelpError("Navigation format changed")
        nav.append({"route": values["route"][1], "label": values["en"][1], "capability": cap[1]})
    if not nav or len({n["route"] for n in nav}) != len(nav):
        raise HelpError("Empty or duplicated navigation inventory")
    known = {item["route"] for item in routes}
    for item in nav:
        if item["route"].split("?", 1)[0] not in known:
            raise HelpError("Navigation points to an undocumented page")
        if item["route"] not in known:
            routes.append({"route": item["route"], "source": "apps/web/src/app/(app)/nav.ts"})
            known.add(item["route"])
    return {"routes": sorted(routes, key=lambda x: x["route"]), "roles": roles,
            "matrix": matrix, "navigation": nav}


def sources(root: Path) -> dict[str, str]:
    paths = set()
    for folder in WATCH:
        for path in (root / folder).rglob("*"):
            name = path.name
            if any(part in {".terraform", "__pycache__", "node_modules", "dist", "coverage", "tests"}
                   for part in path.relative_to(root).parts):
                continue
            if path.is_file() and not any(x in name for x in (".test.", ".spec.", ".helper.")):
                if path.suffix in {".ts", ".tsx", ".py", ".sql", ".css", ".json", ".yaml", ".yml", ".jinja", ".j2", ".tf", ".tpl", ".sh"} or name.endswith(".example") or name.startswith("Dockerfile"):
                    paths.add(path.relative_to(root).as_posix())
    for pattern in ("apps/*/.env.example", "services/*/.env.example"):
        paths.update(path.relative_to(root).as_posix() for path in root.glob(pattern) if path.is_file())
    for name in ("docker-compose.yml", "scripts/bootstrap-onprem.sh", "scripts/build-preprod-images.sh",
                 "scripts/teardown-preprod-gcp.sh", "scripts/deploy-staging.sh", "scripts/deploy-firebase-marketing.sh"):
        if (root / name).is_file():
            paths.add(name)
    for path in ("scripts/axiom-ops.sh", "scripts/sync-env.sh", "scripts/dev-docker.sh",
                 "scripts/deploy-preprod-gcp.sh", "scripts/run-deployed-acceptance.sh",
                 "private-docs/reference/02_Phase_Wise_Implementation_Plan.md", "private-docs/reference/03_BRD_PRD.md",
                 "scripts/help-manuals.py", ".github/workflows/help-manuals.yml",
                 "scripts/check-private-docs.sh",
                 *["private-docs/help/assets/" + asset for asset in ASSETS]):
        paths.add(path)
    return {name: digest(safe_file(root, name)) for name in sorted(paths)}


def generated_reference(data: dict, audience: str) -> str:
    audience_roles = {"client": ["OWNER", "ADMIN", "APPROVER", "REVIEWER", "VIEWER"],
                      "partner": ["PARTNER"], "founder": list(data["roles"])}[audience]
    lines = [BEGIN, "## Generated navigation and role reference", "",
             "This reference lists role eligibility, not a grant of access or a promise that every",
             "feature is enabled. Your selected organization, assignment, review scope and",
             "release readiness still apply. A missing action must be investigated, not bypassed.", "",
             "| Navigation label | Location | Eligible roles in this manual |", "| --- | --- | --- |"]
    for nav in data["navigation"]:
        allowed = [r for r in audience_roles if nav["capability"] in data["matrix"][r]]
        if nav["route"] == "/reports?tab=pramaan":
            allowed = [r for r in allowed if r in {"OWNER", "ADMIN", "FOUNDER"}]
        if audience != "founder":
            allowed = [r for r in allowed if nav["route"] != "/workbench"]
        if allowed:
            labels = ", ".join(data["roles"][r].replace("_", " ") for r in allowed)
            lines.append(f"| {nav['label']} | `{nav['route']}` | {labels} |")
    lines += ["", "| Action | " + " | ".join(data["roles"][r].replace("_", " ") for r in audience_roles) + " |",
              "| --- | " + " | ".join("---" for _ in audience_roles) + " |"]
    for cap, label in ACTION_LABELS.items():
        lines.append("| " + label + " | " + " | ".join(
            "Eligible; conditions apply" if cap in data["matrix"][r] else "Not granted by this role"
            for r in audience_roles) + " |")
    lines += ["", "Personal sign-in and security settings remain subject to account state.",
              "Reports that require a separate release or permission are not made available by this table.", END]
    return "\n".join(lines)


def normalized_reference(text: str) -> str:
    # Formatters pad Markdown table separators with dashes as well as spaces.
    content = re.sub(r"(?m)^\|[| :\-]+\|\s*$", "", text)
    return re.sub(r"\s+", "", content)


def with_reference(text: str, reference: str) -> str:
    if text.count(BEGIN) != text.count(END) or text.count(BEGIN) > 1:
        raise HelpError("Invalid generated-reference markers")
    if BEGIN in text:
        previous = text.split(BEGIN, 1)[1].split(END, 1)[0]
        fresh = reference.split(BEGIN, 1)[1].split(END, 1)[0]
        if normalized_reference(previous) == normalized_reference(fresh):
            return text
        return text.split(BEGIN, 1)[0].rstrip() + "\n\n" + reference + "\n"
    return text.rstrip() + "\n\n" + reference + "\n"


def validate_cases(root: Path, data: dict) -> dict:
    raw = json.loads(safe_file(root, CASES).read_text())
    if set(raw) != {"schemaVersion", "cases"} or raw["schemaVersion"] != 1 or not isinstance(raw["cases"], list):
        raise HelpError("Invalid manual case suite")
    keys = {"id", "title", "routes", "personas", "requirementRefs", "availability",
            "preconditions", "steps", "expected", "evidence", "destructive"}
    ids, covered = set(), set()
    known = {r["route"] for r in data["routes"]}
    valid_states = {"current", "staged", "candidate", "blocked", "conditional"}
    for case in raw["cases"]:
        if not isinstance(case, dict) or set(case) != keys:
            raise HelpError("Manual case has unknown or missing fields")
        if not isinstance(case["id"], str) or not re.fullmatch(r"[A-Z0-9-]+", case["id"]) or case["id"] in ids:
            raise HelpError("Invalid or duplicate case ID")
        ids.add(case["id"])
        if not isinstance(case["title"], str) or not case["title"].strip():
            raise HelpError("Missing case title")
        if case["availability"] not in valid_states or type(case["destructive"]) is not bool:
            raise HelpError("Invalid case readiness or destructive flag")
        for key in ("routes", "personas", "requirementRefs", "preconditions", "steps", "expected", "evidence"):
            if not isinstance(case[key], list) or any(not isinstance(v, str) or not v.strip() for v in case[key]):
                raise HelpError(f"Invalid case {key}")
            if key != "routes" and not case[key]:
                raise HelpError(f"Empty case {key}")
        if not set(case["routes"]).issubset(known):
            raise HelpError(f"Unknown case route in {case['id']}")
        covered.update(case["routes"])
    if known - covered:
        raise HelpError("Missing manual cases for routes: " + ", ".join(sorted(known - covered)))
    return raw


def approved_svg(root: Path, name: str) -> bytes:
    if name not in ASSETS:
        raise HelpError("Unapproved screen illustration")
    raw = safe_file(root, f"private-docs/help/assets/{name}").read_bytes()
    if len(raw) > 2_000_000:
        raise HelpError("Illustration exceeds approved size")
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise HelpError("Unsafe illustration declarations")
    if FORBIDDEN.search(raw.decode("utf-8")) or b"@" in raw:
        raise HelpError("Confidential or account information in shared illustration")
    # DTD/entities were rejected above; external references are not accepted.
    node = ET.fromstring(raw)  # nosec B314
    allowed = {"svg", "g", "rect", "text", "tspan", "path", "line", "circle", "title", "desc"}
    for element in node.iter():
        if element.tag.split("}")[-1] not in allowed:
            raise HelpError("Unsafe illustration element")
        if any(k.lower().startswith("on") or "href" in k.lower() or "url(" in v.lower()
               for k, v in element.attrib.items()):
            raise HelpError("Unsafe illustration attribute")
    return raw


def validate_external(root: Path, audience: str, text: str) -> None:
    if audience not in {"client", "partner"}:
        raise HelpError("Only client and partner manuals may be shared")
    match = FORBIDDEN.search(text)
    if match:
        raise HelpError(f"Confidential content marker in {audience} manual; review locally")
    if re.search(r"(?i)<\s*(script|iframe|object|embed|svg)\b", text):
        raise HelpError("Embedded active content is not allowed in external manuals")
    route_paths = {item["route"].split("?", 1)[0] for item in inventory(root)["routes"] if not item["route"].startswith("marketing:")}
    for image, target in re.findall(r"(!?)\[[^\]]*\]\(([^)]+)\)", text):
        if image:
            if target not in {f"../assets/{name}" for name in ASSETS}:
                raise HelpError("External image is not an approved fictional illustration")
            approved_svg(root, Path(target).name)
        elif target.startswith("#"):
            continue
        else:
            parsed = urlsplit(target)
            if target.startswith("//") or parsed.scheme not in {"", "https"} or parsed.netloc not in {"", "app.axiomproof.ai", "axiomproof.ai"} or parsed.username or parsed.password:
                raise HelpError("External manual link points outside approved product/help scope")
            if parsed.netloc == "axiomproof.ai":
                allowed = {item["route"].removeprefix("marketing:") for item in inventory(root)["routes"] if item["route"].startswith("marketing:")}
            else:
                allowed = route_paths
            if not parsed.path.startswith("/") or ".." in parsed.path.split("/") or not any(re.fullmatch(re.sub(r"\\\[[^\]]+\\\]", "[^/]+", re.escape(route)), parsed.path) for route in allowed):
                raise HelpError("External manual link is not a known product route")
            if parsed.query and parsed.query not in {"mode=signup", "tab=pramaan"}:
                raise HelpError("External manual contains unapproved query parameters")


def public_coverage(cases: dict) -> dict:
    # No scenario steps, architecture, private operator inputs or result artifacts.
    return {"schemaVersion": 1, "cases": [{"id": c["id"], "routes": c["routes"],
            "availability": c["availability"]} for c in cases["cases"]]}


def validate_coverage(root: Path, data: dict) -> dict:
    raw = json.loads(safe_file(root, COVERAGE).read_text())
    if set(raw) != {"schemaVersion", "cases"} or raw["schemaVersion"] != 1:
        raise HelpError("Invalid public coverage receipt")
    known = {r["route"] for r in data["routes"]}
    ids, covered = set(), set()
    for case in raw["cases"]:
        if set(case) != {"id", "routes", "availability"} or not isinstance(case["id"], str):
            raise HelpError("Private content or malformed fields in public coverage")
        if case["id"] in ids or not re.fullmatch(r"[A-Z0-9-]+", case["id"]):
            raise HelpError("Duplicate or invalid public case ID")
        ids.add(case["id"])
        if not isinstance(case["routes"], list) or any(not isinstance(r, str) for r in case["routes"]):
            raise HelpError("Invalid public case routes")
        if not set(case["routes"]).issubset(known):
            raise HelpError("Unknown public case route")
        if case["availability"] not in {"current", "staged", "candidate", "blocked", "conditional"}:
            raise HelpError("Invalid public readiness")
        covered.update(case["routes"])
    if known - covered:
        raise HelpError("Missing manual cases for routes: " + ", ".join(sorted(known - covered)))
    return raw


def sync(root: Path, reason: str) -> dict:
    if len(reason.strip()) < 12:
        raise HelpError("Record a meaningful review reason for prose/feature readiness")
    data = inventory(root)
    cases = validate_cases(root, data)
    proposed = {}
    for audience, name in MANUALS.items():
        text = with_reference(safe_file(root, name).read_text(), generated_reference(data, audience))
        if audience != "founder":
            validate_external(root, audience, text)
        proposed[name] = text
    for name, text in proposed.items():
        (root / name).write_text(text)
        if name.startswith("private-docs/"):
            (root / name).chmod(0o600)
    maintenance = root / "private-docs/help/maintenance"
    maintenance.mkdir(parents=True, exist_ok=True)
    (root / COVERAGE).write_text(json.dumps(public_coverage(cases), indent=2) + "\n")
    result = {"schemaVersion": 1, "reviewReason": reason.strip(), "sources": sources(root),
              "manuals": {name: digest(safe_file(root, name)) for name in
                          [MANUALS["client"], MANUALS["partner"], COVERAGE]},
              "privateReview": {"documents": {
                  "founder": digest(safe_file(root, MANUALS["founder"])),
                  "testing": digest(safe_file(root, PRIVATE_TESTING)),
                  "cases": digest(safe_file(root, CASES))}},
              "routes": data["routes"], "roles": data["roles"]}
    (root / INDEX).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    return result


def check(root: Path, require_private: bool = False) -> dict:
    # The repository is public: internal prose can never be part of tracked help.
    if not (root / "docs").is_symlink() and (root / "docs/help/internal").exists() and any((root / "docs/help/internal").rglob("*")):
        raise HelpError("Internal help belongs in protected ignored storage, not the public repository")
    if not (root / "private-docs").is_dir() or (root / "private-docs").stat().st_mode & 0o077:
        raise HelpError("Private documentation folder is missing or lacks private permissions")
    data = inventory(root)
    cases = validate_coverage(root, data)
    stored = json.loads(safe_file(root, INDEX).read_text())
    if stored.get("schemaVersion") != 1 or not stored.get("reviewReason"):
        raise HelpError("Missing reviewed source index")
    actual_sources = sources(root)
    if stored["sources"] != actual_sources:
        changed = set(stored["sources"]) ^ set(actual_sources)
        changed.update(k for k in set(stored["sources"]) & set(actual_sources)
                       if stored["sources"][k] != actual_sources[k])
        raise HelpError("Feature/config drift requires private manual review and help:sync: " + ", ".join(sorted(changed)[:8]))
    if stored["routes"] != data["routes"] or stored["roles"] != data["roles"]:
        raise HelpError("Route/role index is stale")
    for name, expected in stored["manuals"].items():
        if name not in {MANUALS["client"], MANUALS["partner"], COVERAGE}:
            raise HelpError("Unexpected manual in public review index")
        if digest(safe_file(root, name)) != expected:
            raise HelpError("Manual changed after its last recorded review: " + name)
    if set(stored["manuals"]) != {MANUALS["client"], MANUALS["partner"], COVERAGE}:
        raise HelpError("Incomplete public review index")
    private_documents = stored["privateReview"]["documents"]
    if set(private_documents) != {"founder", "testing", "cases"} or any(
            not isinstance(v, str) or not re.fullmatch("[a-f0-9]{64}", v)
            for v in private_documents.values()):
        raise HelpError("Missing private-document review receipt")
    for audience in ("client", "partner"):
        text = safe_file(root, MANUALS[audience]).read_text()
        expected = generated_reference(data, audience)
        if BEGIN not in text or END not in text or normalized_reference(text.split(BEGIN, 1)[1].split(END, 1)[0]) != normalized_reference(expected.split(BEGIN, 1)[1].split(END, 1)[0]):
            raise HelpError("Generated role/navigation reference is stale")
        validate_external(root, audience, text)
    for name in ASSETS:
        approved_svg(root, name)
    if require_private:
        if any((root / folder).stat().st_mode & 0o077 for folder in ("private-docs", "private-docs/help/internal", "private-docs/testing")):
            raise HelpError("Private manual directory lacks private permissions")
        private_paths = {"founder": MANUALS["founder"], "testing": PRIVATE_TESTING, "cases": CASES}
        for name, path in private_paths.items():
            file = safe_file(root, path)
            if file.stat().st_mode & 0o077 or digest(file) != private_documents[name]:
                raise HelpError("Private manual changed, is missing, or lacks private file permissions")
        if public_coverage(validate_cases(root, data)) != cases:
            raise HelpError("Private cases differ from their sanitized coverage receipt")
        text = safe_file(root, MANUALS["founder"]).read_text()
        expected = generated_reference(data, "founder")
        if BEGIN not in text or normalized_reference(text.split(BEGIN, 1)[1].split(END, 1)[0]) != normalized_reference(expected.split(BEGIN, 1)[1].split(END, 1)[0]):
            raise HelpError("Internal generated reference is stale")
    return {"routes": len(data["routes"]), "cases": len(cases["cases"]),
            "sources": len(actual_sources), "externalManuals": 2, "privateChecked": require_private}


def inline(root: Path, text: str) -> str:
    result, cursor = [], 0
    pattern = re.compile(r"(!?)\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*")
    for token in pattern.finditer(text):
        result.append(html.escape(text[cursor:token.start()]))
        if token[2] is not None:
            label, url = token[2], token[3]
            if token[1]:
                svg = approved_svg(root, Path(url).name)
                result.append(f'<img alt="{html.escape(label, quote=True)}" src="data:image/svg+xml;base64,{base64.b64encode(svg).decode()}" />')
            else:
                href = "https://app.axiomproof.ai" + url if url.startswith("/") else url
                result.append(f'<a href="{html.escape(href, quote=True)}">{html.escape(label)}</a>')
        elif token[4] is not None:
            result.append("<code>" + html.escape(token[4]) + "</code>")
        else:
            result.append("<strong>" + html.escape(token[5]) + "</strong>")
        cursor = token.end()
    result.append(html.escape(text[cursor:]))
    return "".join(result)


def markdown_html(root: Path, text: str) -> str:
    # Always escape raw HTML. Only locally generated HTML structure is emitted.
    lines = text.splitlines()
    result, i, ids = [], 0, set()
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.startswith("<!--"):
            i += 1
            continue
        if line.startswith("```"):
            code, i = [], i + 1
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i]); i += 1
            result.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
            i += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)", line)
        if heading:
            anchor = re.sub(r"[^\w -]", "", heading[2].lower()).replace(" ", "-")
            base, suffix = anchor, 1
            while anchor in ids:
                anchor = f"{base}-{suffix}"; suffix += 1
            ids.add(anchor)
            level = len(heading[1])
            result.append(f'<h{level} id="{anchor}">{inline(root, heading[2])}</h{level}>')
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.fullmatch(r"[| :\-]+", lines[i + 1]):
            cells = lambda value: [x.strip() for x in value.strip().strip("|").split("|")]
            result.append('<div class="table-scroll"><table><thead><tr>' + "".join("<th>" + inline(root, x) + "</th>" for x in cells(line)) + "</tr></thead><tbody>")
            i += 2
            while i < len(lines) and lines[i].startswith("|"):
                result.append("<tr>" + "".join("<td>" + inline(root, x) + "</td>" for x in cells(lines[i])) + "</tr>"); i += 1
            result.append("</tbody></table></div>")
            continue
        if re.match(r"^\s*(?:[-*]|\d+\.)\s+", line):
            ordered = bool(re.match(r"^\s*\d+\.", line)); tag = "ol" if ordered else "ul"
            result.append(f"<{tag}>")
            while i < len(lines) and re.match(r"^\s*(?:[-*]|\d+\.)\s+", lines[i]):
                item = re.sub(r"^\s*(?:[-*]|\d+\.)\s+", "", lines[i]); i += 1
                while i < len(lines) and lines[i].startswith("   "):
                    item += " " + lines[i].strip(); i += 1
                result.append("<li>" + inline(root, item) + "</li>")
            result.append(f"</{tag}>")
            continue
        paragraph = [line]; i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(?:#|\||```|<!--|\s*(?:[-*]|\d+\.)\s)", lines[i]):
            paragraph.append(lines[i]); i += 1
        result.append("<p>" + inline(root, " ".join(paragraph)) + "</p>")
    return "\n".join(result)


def export(root: Path, audience: str, output: Path) -> Path:
    root = root.resolve()
    if audience not in {"client", "partner"}:
        raise HelpError("Internal founder/QA manuals cannot be exported by the sharing command")
    check(root)
    if output.is_symlink():
        raise HelpError("Sharing output may not be a symlink")
    output = output.resolve()
    if output.exists() and (not output.is_dir() or output.is_symlink()):
        raise HelpError("Sharing output must be a regular directory")
    # Never overwrite source docs or expose manuals under application public assets.
    if any(output.is_relative_to(root / name) for name in ("docs", "apps", "services", "packages")) or output == root:
        raise HelpError("Share output must be outside source/public trees")
    if output.is_relative_to(root) and not output.is_relative_to(root / "private-docs/help/share"):
        raise HelpError("In-repository help exports belong only in ignored private-docs/help/share")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any(output.iterdir()):
        raise HelpError("Use a fresh empty share directory; existing files might contain internal content")
    text = safe_file(root, MANUALS[audience]).read_text()
    validate_external(root, audience, text)
    body = markdown_html(root, text)
    title = f"Axiom Proof — {audience.title()} Help Manual"
    style = "body{font:16px/1.65 system-ui,sans-serif;color:#1e2a4a;margin:auto;padding:24px;max-width:1100px}h1,h2,h3{line-height:1.25}h2{border-bottom:2px solid #0fb5a5;padding-top:24px}a{color:#087f77}img{width:100%;height:auto;border:1px solid #dbe2ea;border-radius:12px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #dbe2ea;padding:8px;text-align:left;vertical-align:top}th{background:#eff6f7}.table-scroll{overflow:auto}code{background:#f1f5f9;padding:2px 4px}pre{overflow:auto;background:#f1f5f9;padding:16px}@media print{body{max-width:none;padding:0}h2{break-after:avoid}img,tr{break-inside:avoid}}"
    page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' + html.escape(title) + '</title><style>' + style + '</style></head><body><main>' + body + '</main></body></html>'
    path = output / f"{audience}-help.html"
    path.write_text(page); path.chmod(0o600)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    check_parser = sub.add_parser("check")
    check_parser.add_argument("--require-private", action="store_true")
    sync_parser = sub.add_parser("sync")
    sync_parser.add_argument("--review-reason", required=True)
    export_parser = sub.add_parser("export")
    export_parser.add_argument("--audience", choices=("client", "partner"), required=True)
    export_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "sync":
            result = sync(ROOT, args.review_reason)
            print(f"Reviewed help synchronized: {len(result['routes'])} routes; generated navigation/role references updated.")
        elif args.command == "check":
            print("Help checks passed: " + json.dumps(check(ROOT, args.require_private), sort_keys=True))
        else:
            print(f"External {args.audience} manual exported: {export(ROOT, args.audience, args.output)}")
    except (HelpError, OSError, KeyError, TypeError, json.JSONDecodeError, ET.ParseError) as exc:
        parser.exit(1, f"Help check refused: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
