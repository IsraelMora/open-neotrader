"""
Tests for plugins/macro-calendar-guard/scripts/calendar.py.

Fix C regression coverage: get_active_blackouts() used to build event_dt as a
NAIVE datetime (no tzinfo), then compare it against an AWARE `now` (e.g.
datetime.now(tz=UTC)) via `win_start <= now <= win_end` — comparing a naive and
an aware datetime raises `TypeError: can't compare offset-naive and
offset-aware datetimes`. Fixed by giving event_dt `tzinfo=UTC` (see the diff
on plugins/macro-calendar-guard/scripts/calendar.py: `datetime(..., tzinfo=UTC)`).

These tests call get_active_blackouts with an AWARE `now` (the real-world
caller shape) to pin the fix and prevent a naive-datetime regression.
"""

from __future__ import annotations

import importlib.util
import os
from datetime import UTC, datetime

_PLUGIN_ROOT = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__), "..", "..", "..", "..", "plugins", "macro-calendar-guard"
    )
)
_SCRIPTS = os.path.join(_PLUGIN_ROOT, "scripts")


def _load_calendar_module():
    """
    Load scripts/calendar.py under a unique module name.

    A bare `from calendar import ...` (even via sys.path insertion) risks
    colliding with — and permanently shadowing in sys.modules — the Python
    STDLIB `calendar` module for the rest of the pytest session, breaking any
    other test that needs the real stdlib module. Load by explicit file path
    instead, same pattern as tests/momentum-factor-12-1/test_momentum.py.
    """
    spec = importlib.util.spec_from_file_location(
        "_macro_calendar_guard_calendar", os.path.join(_SCRIPTS, "calendar.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


get_active_blackouts = _load_calendar_module().get_active_blackouts


class TestGetActiveBlackoutsTzAware:
    def test_does_not_raise_with_aware_now_and_no_extra_events(self) -> None:
        """get_active_blackouts(datetime.now(tz=UTC), cfg, None) must not raise
        TypeError comparing naive vs aware datetimes."""
        now = datetime.now(tz=UTC)
        cfg: dict = {}
        # Must not raise
        result = get_active_blackouts(now, cfg, None)
        assert isinstance(result, list)

    def test_does_not_raise_with_aware_now_and_extra_events(self) -> None:
        """Same, but with an LLM-injected extra_events list (a second code path
        that also builds a MacroEvent -> event_dt)."""
        now = datetime.now(tz=UTC)
        cfg: dict = {}
        extra_events = [
            {
                "name": "Custom Macro Event",
                "date": now.date().isoformat(),
                "time_utc": f"{now.hour:02d}:{now.minute:02d}",
                "category": "other",
                "impact": "high",
                "affected": "all",
            }
        ]
        # Must not raise
        result = get_active_blackouts(now, cfg, extra_events)
        assert isinstance(result, list)

    def test_returns_a_blackout_when_now_is_inside_an_event_window(self) -> None:
        """An aware `now` exactly at a fixed FOMC event time must be reported as an
        active blackout window (proves the aware event_dt comparison actually works,
        not just that it avoids raising)."""
        # Reuse a real fixed 2026 FOMC event from FIXED_EVENTS_2026: 2026-01-28 19:00 UTC.
        now = datetime(2026, 1, 28, 19, 0, tzinfo=UTC)
        cfg: dict = {"blackout_hours_before": 4, "blackout_hours_after": 2}

        result = get_active_blackouts(now, cfg, None)

        assert len(result) > 0, "Expected an active blackout at the exact FOMC event time"
        assert any("FOMC" in b.reason for b in result)
        assert any(b.is_blackout for b in result), (
            "now == event time must fall inside the 1h-before/1h-after total blackout window"
        )

    def test_no_blackout_far_outside_any_event_window(self) -> None:
        """Sanity check: an aware `now` far from any event returns no blackout
        (and, critically, still does not raise)."""
        now = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)  # New Year's Day, well before any window
        cfg: dict = {"blackout_hours_before": 4, "blackout_hours_after": 2}

        result = get_active_blackouts(now, cfg, None)

        assert result == []
