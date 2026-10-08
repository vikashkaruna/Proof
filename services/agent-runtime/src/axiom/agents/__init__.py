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

from .drishti import DrishtiAgent
from .karya import KaryaAgent
from .lekha import LekhaAgent
from .nazar import NazarAgent
from .parikshan import ParikshanAgent
from .pramaan import PramaanAgent
from .prativedan import PrativedanAgent
from .saakshi import SaakshiAgent
from .samadhan import SamadhanAgent
from .sanket import SanketAgent
from .sudhaar import SudhaarAgent
from .vibhaag import VibhaagAgent

__all__ = [
    "DrishtiAgent",
    "KaryaAgent",
    "LekhaAgent",
    "NazarAgent",
    "ParikshanAgent",
    "PramaanAgent",
    "PrativedanAgent",
    "SaakshiAgent",
    "SamadhanAgent",
    "SanketAgent",
    "SudhaarAgent",
    "VibhaagAgent",
]
