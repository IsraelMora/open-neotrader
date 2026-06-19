"""
Tests for PR D — telegram-notifier owns notification policy.

D1.1: signal above min_confidence → notify_intents has one telegram entry.
D1.2: signal below threshold → notify_intents absent or empty.
D1.3: no signals in ctx → notify_intents absent or empty.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).parents[3] / "plugins" / "telegram-notifier"
HOOK_PATH = PLUGIN_DIR / "hooks" / "on_cycle.py"


def _load_on_cycle():
    """Load the on_cycle hook from telegram-notifier."""
    spec = importlib.util.spec_from_file_location("telegram_notifier_on_cycle", HOOK_PATH)
    assert spec is not None and spec.loader is not None, (
        f"Cannot load {HOOK_PATH} — file does not exist yet (create it in D2.2)"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


# ── D1.1 ──────────────────────────────────────────────────────────────────────

def test_signal_above_threshold_emits_notify_intent():
    """D1.1 — signal with confidence=0.85 above min_confidence=0.7 → notify_intents has telegram entry."""
    mod = _load_on_cycle()

    ctx = {
        "signals": [
            {"symbol": "AAPL", "action": "buy", "confidence": 0.85},
        ],
        "plugin_config": {"min_confidence": 0.7, "max_messages_per_cycle": 10},
    }

    result = mod.on_cycle(ctx)

    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    intents = result.get("notify_intents", [])
    assert len(intents) >= 1, (
        f"Expected at least one notify_intent for signal above threshold, got: {intents}"
    )
    telegram_intents = [i for i in intents if i.get("channel") == "telegram"]
    assert len(telegram_intents) >= 1, (
        f"Expected a telegram intent, got: {intents}"
    )
    assert telegram_intents[0].get("text"), "notify_intent text must be non-empty"


# ── D1.2 ──────────────────────────────────────────────────────────────────────

def test_signal_below_threshold_no_intent():
    """D1.2 — signal with confidence=0.5 below min_confidence=0.7 → no notify_intents."""
    mod = _load_on_cycle()

    ctx = {
        "signals": [
            {"symbol": "TSLA", "action": "sell", "confidence": 0.5},
        ],
        "plugin_config": {"min_confidence": 0.7, "max_messages_per_cycle": 10},
    }

    result = mod.on_cycle(ctx)

    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    intents = result.get("notify_intents", [])
    assert len(intents) == 0, (
        f"Expected no notify_intents for signal below threshold, got: {intents}"
    )


# ── D1.3 ──────────────────────────────────────────────────────────────────────

def test_no_signals_no_intent():
    """D1.3 — no signals in ctx → notify_intents absent or empty."""
    mod = _load_on_cycle()

    ctx = {
        "plugin_config": {"min_confidence": 0.7, "max_messages_per_cycle": 10},
    }

    result = mod.on_cycle(ctx)

    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    intents = result.get("notify_intents", [])
    assert len(intents) == 0, (
        f"Expected no notify_intents when no signals present, got: {intents}"
    )


# ── Bonus: max_messages_per_cycle cap ─────────────────────────────────────────

def test_max_messages_per_cycle_caps_intents():
    """D extra — max_messages_per_cycle=2 with 5 qualifying signals → at most 2 intents."""
    mod = _load_on_cycle()

    ctx = {
        "signals": [
            {"symbol": f"SYM{i}", "action": "buy", "confidence": 0.9}
            for i in range(5)
        ],
        "plugin_config": {"min_confidence": 0.7, "max_messages_per_cycle": 2},
    }

    result = mod.on_cycle(ctx)

    intents = result.get("notify_intents", [])
    assert len(intents) <= 2, (
        f"Expected at most 2 intents due to max_messages_per_cycle=2, got: {len(intents)}"
    )
