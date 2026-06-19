"""
Tests for PR C — weekly-reporter off urllib.

C1.1: reporter.py must NOT import urllib.
C1.2: on_cycle with equity_curve+closed_trades → notify_intents has telegram entry with non-empty text.
C1.3: on_cycle({}) → no exception, no intent (graceful degradation).
"""
from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

PLUGIN_DIR = Path(__file__).parents[3] / "plugins" / "weekly-reporter"
REPORTER_PATH = PLUGIN_DIR / "scripts" / "reporter.py"
HOOK_PATH = PLUGIN_DIR / "hooks" / "on_cycle.py"


def _load_reporter_source() -> str:
    return REPORTER_PATH.read_text(encoding="utf-8")


def _load_on_cycle():
    """Load on_cycle from weekly-reporter, clearing any sandbox urllib poisoning."""
    for blocked_mod in list(sys.modules.keys()):
        if sys.modules[blocked_mod] is None and (
            blocked_mod.startswith("urllib") or blocked_mod in ("socket", "ssl", "http")
        ):
            del sys.modules[blocked_mod]

    spec = importlib.util.spec_from_file_location("wr_on_cycle_c", HOOK_PATH)
    assert spec is not None and spec.loader is not None, f"Cannot load {HOOK_PATH}"
    mod = importlib.util.module_from_spec(spec)
    plugin_str = str(PLUGIN_DIR)
    if plugin_str not in sys.path:
        sys.path.insert(0, plugin_str)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


# ── C1.1 ──────────────────────────────────────────────────────────────────────

def test_reporter_has_no_urllib_import():
    """C1.1 — reporter.py must not contain 'urllib'."""
    src = _load_reporter_source()
    assert "urllib" not in src, (
        "reporter.py still imports urllib — remove import urllib.request and send_telegram()"
    )


# ── C1.2 ──────────────────────────────────────────────────────────────────────

def test_on_cycle_emits_notify_intent_with_context():
    """C1.2 — on_cycle with equity_curve+closed_trades emits notify_intents[channel=telegram, text non-empty]."""
    mod = _load_on_cycle()

    # Force today to be the configured report day so the hook actually fires
    _WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    today_name = _WEEKDAYS[time.gmtime().tm_wday]

    ctx = {
        "equity_curve": [100.0, 101.0, 103.0, 102.0, 104.0, 105.0],
        "closed_trades": [
            {"symbol": "AAPL", "action": "buy", "pnl": 1.5, "ts": "2026-01-01"},
            {"symbol": "TSLA", "action": "sell", "pnl": -0.5, "ts": "2026-01-02"},
            {"symbol": "NVDA", "action": "buy", "pnl": 2.0, "ts": "2026-01-03"},
            {"symbol": "MSFT", "action": "buy", "pnl": 0.8, "ts": "2026-01-04"},
            {"symbol": "GOOG", "action": "sell", "pnl": -0.3, "ts": "2026-01-05"},
        ],
        # Configure today as the weekly report day so the hook fires regardless of wall-clock
        "plugin_config": {"min_trades": 5, "weekly_report_day": today_name},
    }

    result = mod.on_cycle(ctx)

    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    intents = result.get("notify_intents", [])
    assert len(intents) >= 1, (
        f"Expected at least one notify_intent, got: {intents}"
    )
    telegram_intents = [i for i in intents if i.get("channel") == "telegram"]
    assert len(telegram_intents) >= 1, (
        f"Expected a telegram intent, got: {intents}"
    )
    text = telegram_intents[0].get("text", "")
    assert text, "notify_intent text must be non-empty"


# ── C1.3 ──────────────────────────────────────────────────────────────────────

def test_on_cycle_empty_ctx_no_exception_no_intent():
    """C1.3 — on_cycle({}) must not raise and must not emit notify_intents."""
    mod = _load_on_cycle()

    result = mod.on_cycle({})

    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    # Either ok=False with no intents, or intents is empty/absent
    intents = result.get("notify_intents", [])
    assert len(intents) == 0, (
        f"Expected empty notify_intents on thin context, got: {intents}"
    )
