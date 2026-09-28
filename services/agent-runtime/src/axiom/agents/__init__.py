"""Agent implementations for Axiom Proof.

Named agents:
  - Drishti   (Discovery)
  - Vibhaag   (Classification)
  - Parikshan (Assessment)
  - Saakshi   (Evidence)
  - Sudhaar   (Remediation Planning)
  - Karya     (Execution) — Phase 3, stub here
  - Samadhan  (Maker-Checker & Reconciler)
  - Lekha     (Audit & Traceability)
  - Nazar     (Regulatory Watch)
  - Prativedan (Reporting)
  - Sanket    (Market Signal — internal GTM)
"""

from .parikshan import ParikshanAgent
from .prativedan import PrativedanAgent
from .drishti import DrishtiAgent
from .vibhaag import VibhaagAgent
from .saakshi import SaakshiAgent
from .sudhaar import SudhaarAgent
from .lekha import LekhaAgent
from .nazar import NazarAgent
from .sanket import SanketAgent
from .karya import KaryaAgent
from .samadhan import SamadhanAgent
from .pramaan import PramaanAgent

__all__ = [
    "ParikshanAgent",
    "PrativedanAgent",
    "DrishtiAgent",
    "VibhaagAgent",
    "SaakshiAgent",
    "SudhaarAgent",
    "LekhaAgent",
    "NazarAgent",
    "SanketAgent",
    "KaryaAgent",
    "SamadhanAgent",
    "PramaanAgent",
]
