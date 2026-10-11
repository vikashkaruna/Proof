#!/usr/bin/env python3
"""Claude Code PreToolUse hook: keep confidential documentation and secrets out of git.

Exit 2 blocks the tool call and returns the message to Claude. Blocks:
  * Bash: `git add -f/--force`; `git add` naming docs/private-docs, docs/private-plans or the
    legacy private-docs/ (README files excepted); `--no-verify` on commit or push; force-pushes.
  * Write/Edit: secret-looking values in any tracked documentation path, a shared document
    without `classification: shared`, and private-zone files whose name breaks the convention.
The pre-commit guard (scripts/guard-private-docs.sh) is the backstop for everything else.
"""
import json
import re
import sys

SECRET = re.compile(
    r"(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}"
    r"|(?i:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*[\"']?[A-Za-z0-9/+_-]{16,})"
)
PRIVATE_ZONE = re.compile(r"(^|/)(docs/private-docs|docs/private-plans|private-docs)/")
NAME_OK = re.compile(
    r"^(README\.md|INDEX\.md|relocation-map\.md|"
    r"(OPS|TEST)-\d{2}-[a-z0-9-]+\.md|TEST-DATA-[a-z0-9-]+\.json|TEST-SUITES-[a-z0-9-]+\.md|"
    r"(ARCH|REQ|SEC|HELP|STATUS|PLAN|REF)-[a-z0-9.-]+\.[a-z]+|"
    r"AUD-\d{8}-\d{3}-[a-z0-9-]+\.md)$"
)


def block(message):
    print(
        f"BLOCKED by documentation policy: {message}\n"
        "Confidential material belongs in docs/private-docs/ or docs/private-plans/ (git-ignored). "
        "See docs/README.md and .agents/skills/doc-classification/SKILL.md.",
        file=sys.stderr,
    )
    sys.exit(2)


data = json.load(sys.stdin)
tool, tool_input = data.get("tool_name", ""), data.get("tool_input", {})

if tool == "Bash":
    for seg in re.split(r"&&|\|\||;|\n", tool_input.get("command", "")):
        # `git -c k=v -C dir commit ...` must not dodge the checks below.
        seg = re.sub(r"\bgit((\s+-c\s+\S+)|(\s+-C\s+\S+)|(\s+--[a-z-]+=\S+))+", "git", seg)
        if re.search(r"\bgit\s+add\b", seg):
            if re.search(r"(\s-f\b|\s--force\b|\s-[a-zA-Z]*f[a-zA-Z]*\b)", seg):
                block("`git add -f` bypasses .gitignore and is not allowed in this repository.")
            if re.search(r"private-(docs|plans)", seg) and not re.search(r"private-(docs|plans)/README\.md", seg):
                block("do not stage anything under docs/private-docs or docs/private-plans.")
        if re.search(r"\bgit\s+commit\b.*(--no-verify|\s-n\b)", seg):
            block("`--no-verify` would skip the confidentiality pre-commit guard.")
        if re.search(r"\bgit\s+push\b.*(--no-verify|\s-n\b)", seg):
            block("`git push --no-verify` would skip the local security gate.")
        if re.search(r"\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b|\s\+\S)", seg):
            block("force-pushing is not allowed here; ask the owner for an explicit, scoped exception.")

elif tool in ("Write", "Edit"):
    path = tool_input.get("file_path", "")
    text = tool_input.get("content") or tool_input.get("new_string") or ""
    in_private = bool(PRIVATE_ZONE.search(path))
    is_doc = ("/docs/" in path or path.endswith(".md")) and not in_private
    if is_doc and SECRET.search(text):
        block(f"secret-looking value in {path}; use a placeholder such as <JWT_SECRET> or move it to the private zone.")
    if "/docs/shared-docs/" in path and path.endswith(".md") and tool == "Write":
        if not re.search(r"(?mi)^classification:\s*shared\s*$", text[:600]):
            block(f"{path} needs the front-matter line `classification: shared`.")
    if in_private and not any(seg in path for seg in ("/_source/", "/archive/", "/help/", "/developer/", "/evidence/")):
        name = path.rsplit("/", 1)[-1]
        if tool == "Write" and "." in name and not NAME_OK.match(name):
            block(f"{name} does not follow the documentation naming convention in docs/README.md.")
sys.exit(0)
