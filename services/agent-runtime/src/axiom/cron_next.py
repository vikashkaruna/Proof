"""W6 — a minimal, deterministic 5-field cron next-fire calculator.

Supports the standard subset the schedule registration validates:
``minute hour dom month dow`` where each field is ``*``, ``*/n``, ``n``,
``n-m`` or ``n-m/n``, and comma-separated lists of those. The standard
DOM/DOW rule applies: if BOTH are restricted (not ``*``), a day matches
when EITHER matches; otherwise both must match.

Pure and total: ``next_fire`` returns a datetime strictly after ``after``
or raises ``CronSyntaxError``. A schedule whose cadence cannot be
computed must never fire on a guess — the scheduler records a failed run
instead.
"""

from __future__ import annotations

import calendar
from datetime import UTC, datetime, timedelta


class CronSyntaxError(ValueError):
    """The cadence cannot be interpreted."""


_MAX_HORIZON_DAYS = 366 * 2


def _parse_field(field: str, low: int, high: int) -> set[int]:
    values: set[int] = set()
    for atom in field.split(","):
        if not atom:
            raise CronSyntaxError(f"empty cron atom in '{field}'")
        step = 1
        body = atom
        if "/" in atom:
            body, _, raw_step = atom.partition("/")
            if not raw_step.isdigit() or int(raw_step) == 0:
                raise CronSyntaxError(f"bad step in '{atom}'")
            step = int(raw_step)
        if body == "*":
            start, end = low, high
        elif "-" in body:
            raw_start, _, raw_end = body.partition("-")
            if not raw_start.isdigit() or not raw_end.isdigit():
                raise CronSyntaxError(f"bad range in '{atom}'")
            start, end = int(raw_start), int(raw_end)
        else:
            if not body.isdigit():
                raise CronSyntaxError(f"bad value in '{atom}'")
            start = end = int(body)
            if "/" in atom:  # e.g. "5/10" — from 5 with step
                end = high
        if start < low or end > high or start > end:
            raise CronSyntaxError(f"value out of range in '{atom}'")
        values.update(range(start, end + 1, step))
    return values


def _matches_day(moment: datetime, doms: set[int], months: set[int], dows: set[int]) -> bool:
    if moment.month not in months:
        return False
    dom_match = moment.day in doms
    dow_match = ((moment.weekday() + 1) % 7) in dows  # cron: 0=Sunday
    dom_restricted = doms != set(range(1, 32))
    dow_restricted = dows != set(range(7))
    if dom_restricted and dow_restricted:
        return dom_match or dow_match
    return dom_match and dow_match


def next_fire(cadence: str, after: datetime) -> datetime:
    """The earliest fire strictly after ``after``, for a UTC cadence."""
    fields = cadence.split()
    if len(fields) != 5:
        raise CronSyntaxError("cadence must have exactly 5 fields")
    minutes = _parse_field(fields[0], 0, 59)
    hours = _parse_field(fields[1], 0, 23)
    doms = _parse_field(fields[2], 1, 31)
    months = _parse_field(fields[3], 1, 12)
    dows = _parse_field(fields[4], 0, 6)

    moment = (after + timedelta(minutes=1)).replace(second=0, microsecond=0)
    horizon = after + timedelta(days=_MAX_HORIZON_DAYS)
    while moment <= horizon:
        if not _matches_day(moment, doms, months, dows):
            # Skip to 00:00 of the next day.
            moment = (moment + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if moment.hour not in hours:
            candidates = sorted(h for h in hours if h > moment.hour)
            if not candidates:
                moment = (moment + timedelta(days=1)).replace(hour=0, minute=0)
                continue
            moment = moment.replace(hour=candidates[0], minute=0)
            continue
        if moment.minute in minutes:
            # The month must actually contain the day: "31" never fires in
            # a 30-day month, and "29/2" only in leap years.
            if moment.day <= calendar.monthrange(moment.year, moment.month)[1]:
                return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment
            moment = (moment + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        candidates = sorted(m for m in minutes if m > moment.minute)
        if not candidates:
            moment = (moment + timedelta(hours=1)).replace(minute=0)
            continue
        moment = moment.replace(minute=candidates[0])
    raise CronSyntaxError("no fire within the horizon")
