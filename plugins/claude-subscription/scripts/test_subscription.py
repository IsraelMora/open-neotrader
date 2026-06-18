"""Tests del script subscription.py (sin pytest: asserts + run directo)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))
import cycle  # noqa: E402
from subscription import subscription_status  # noqa: E402


def test_reports_subscription_backend() -> None:
    out = subscription_status({"model": "claude-haiku-4-5-20251001"})
    assert out["backend"] == "claude-subscription"
    assert out["model"] == "claude-haiku-4-5-20251001"
    assert out["requires_api_key"] is False
    assert isinstance(out["note"], str) and out["note"]


def test_defaults_model_when_missing() -> None:
    out = subscription_status({})
    assert out["backend"] == "claude-subscription"
    assert out["model"] == "default"
    assert out["requires_api_key"] is False


def test_hook_annotates_backend_in_context() -> None:
    ctx = cycle.run({"plugin_config": {}})
    assert ctx["llm_backend"] == "claude-subscription"
    assert any("claude-subscription" in line for line in ctx.get("log", []))


def test_hook_preserves_existing_context() -> None:
    ctx = cycle.run({"pending_signals": ["AAPL"], "log": ["prev"]})
    assert ctx["pending_signals"] == ["AAPL"]
    assert "prev" in ctx["log"]


if __name__ == "__main__":
    test_reports_subscription_backend()
    test_defaults_model_when_missing()
    test_hook_annotates_backend_in_context()
    test_hook_preserves_existing_context()
    print("OK: 4 passed")
