"""Typed local core for Delivery Playbook Capture.

Persistence, reporting, and ranking across engagements are application
concerns and remain explicit integration work in the Phase 2 report.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class PlaybookEntry(BaseModel):
    task_name: str = Field(min_length=1, max_length=200)
    source: str = Field(min_length=1, max_length=100)
    duration_minutes: int = Field(ge=0, strict=True)
    repetitions: int = Field(default=1, ge=1, strict=True)
    notes: str = ""
    automation_candidate: bool = False

    @field_validator("task_name", "source", mode="before")
    @classmethod
    def meaningful_text(cls, value: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("A task name and source must contain meaningful text")
        return value.strip()

    @property
    def total_minutes(self) -> int:
        """Observed frequency times time cost, without claiming an annual horizon."""
        return self.duration_minutes * self.repetitions

    @property
    def annual_minutes(self) -> int:
        """Compatibility alias; no annual frequency is inferred from repetitions."""
        return self.total_minutes


def rank_playbook_backlog(entries: list[PlaybookEntry]) -> list[PlaybookEntry]:
    """Rank repeated time cost first, preserving input order for ties."""
    return sorted(entries, key=lambda entry: entry.total_minutes, reverse=True)
