"""W7.0 · SEC-14 / SEC-15 — the agent permission model, pinned across languages.

`04_Solution_Architecture.md` §5.2 calls separation of duties "a genuine
security property, not a talking point". Today it is a talking point:
`tool_scopes` is declared here AND in `packages/types/src/agents.ts`, and
repo-wide it is read in exactly one place — `app.py`, to serialise it into an
API response for display. Nothing enforces it at tool invocation.

Enforcement is W4.3. What these tests do in the meantime is stop the two
declarations drifting apart, which is how SEC-15 (Nazar holding
`control_library.write`, contradicting the architecture) survived unnoticed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from axiom.agents.drishti import DrishtiAgent
from axiom.agents.karya import KaryaAgent
from axiom.agents.lekha import LekhaAgent
from axiom.agents.nazar import NazarAgent
from axiom.agents.parikshan import ParikshanAgent
from axiom.agents.prativedan import PrativedanAgent
from axiom.agents.saakshi import SaakshiAgent
from axiom.agents.sanket import SanketAgent
from axiom.agents.sudhaar import SudhaarAgent
from axiom.agents.vibhaag import VibhaagAgent

PYTHON_AGENTS = {
    "drishti": DrishtiAgent,
    "vibhaag": VibhaagAgent,
    "parikshan": ParikshanAgent,
    "saakshi": SaakshiAgent,
    "sudhaar": SudhaarAgent,
    "karya": KaryaAgent,
    "lekha": LekhaAgent,
    "nazar": NazarAgent,
    "prativedan": PrativedanAgent,
    "sanket": SanketAgent,
}

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_CONTRACTS = REPO_ROOT / "packages" / "types" / "src" / "agents.ts"


def _typescript_scopes() -> dict[str, list[str]]:
    """Extract each agent's declared toolScopes from the TypeScript registry."""
    source = TS_CONTRACTS.read_text(encoding="utf-8")
    scopes: dict[str, list[str]] = {}

    # Each agent is an object literal keyed by its name at two-space indent.
    for match in re.finditer(r"^  (\w+): \{$", source, re.MULTILINE):
        name = match.group(1)
        block_start = match.end()
        next_agent = re.search(r"^  \w+: \{$", source[block_start:], re.MULTILINE)
        block_end = block_start + (next_agent.start() if next_agent else len(source) - block_start)
        block = source[block_start:block_end]

        scope_match = re.search(r"toolScopes: \[([^\]]*)\]", block, re.DOTALL)
        if scope_match:
            scopes[name] = re.findall(r"'([^']+)'", scope_match.group(1))
    return scopes


def test_typescript_registry_is_parseable() -> None:
    """Guard the guard: a parser that silently matches nothing proves nothing."""
    assert TS_CONTRACTS.exists(), f"TypeScript contracts not found at {TS_CONTRACTS}"
    ts = _typescript_scopes()
    assert set(ts) == set(PYTHON_AGENTS), (
        "TypeScript and Python declare different agents: "
        f"only in TS {set(ts) - set(PYTHON_AGENTS)}, only in Python {set(PYTHON_AGENTS) - set(ts)}"
    )


@pytest.mark.security
@pytest.mark.parametrize("name", sorted(PYTHON_AGENTS))
def test_scopes_match_typescript_declaration(name: str) -> None:
    """The same agent must declare the same scopes in both languages.

    Two independent copies of a permission model drift, and when they do the
    one nobody is reading wins.
    """
    ts = _typescript_scopes()
    assert sorted(PYTHON_AGENTS[name].tool_scopes) == sorted(ts[name]), (
        f"{name}: Python declares {PYTHON_AGENTS[name].tool_scopes}, "
        f"TypeScript declares {ts[name]}"
    )


@pytest.mark.security
@pytest.mark.parametrize("name,agent", sorted(PYTHON_AGENTS.items()))
def test_no_agent_may_write_the_control_library(name: str, agent: type) -> None:
    """SEC-15.

    The control library is the definition of what compliance MEANS — the
    baseline every assessment, finding and client report is computed against.
    Nazar held `control_library.write` while being an L1 agent whose whole job
    is ingesting untrusted government web pages, so a poisoned or misread
    gazette page became a silent change to every client's posture with no
    human in the loop.
    """
    assert "control_library.write" not in agent.tool_scopes, (
        f"{name} can rewrite the definition of compliance"
    )


@pytest.mark.security
def test_nazar_proposes_rather_than_writes() -> None:
    """Nazar's correct scope: read external sources, PROPOSE a baseline delta.

    A human accepts the proposal and only then is a new library version cut —
    the same maker-checker pattern as Sudhaar/Karya, applied to the rulebook.
    """
    assert set(NazarAgent.tool_scopes) == {
        "http.read.government_sources",
        "regulatory_signal.write",
    }


@pytest.mark.security
def test_sudhaar_cannot_execute_and_karya_cannot_plan() -> None:
    """BR-1 maker-checker, as declared.

    This holds today because Sudhaar has no code path to an executor, not
    because a permission system prevents it (SEC-14). Pinning the declaration
    is the cheap half; enforcement is W4.3.
    """
    assert "plan.propose" in SudhaarAgent.tool_scopes
    assert not any(s.startswith("connector.write") for s in SudhaarAgent.tool_scopes)
    assert not any(s == "plan.propose" for s in KaryaAgent.tool_scopes)
