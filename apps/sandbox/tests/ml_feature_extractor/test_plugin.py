"""
TDD tests for plugins/ml-feature-extractor/plugin.py.

These tests import plugin.py directly (not via runner) and verify that it:
  - delegates to model.train / model.predict
  - reads config from _context.metadata correctly
  - falls back to defaults when _context is None

RED phase: all tests fail because plugin.py does not exist yet.
GREEN phase: tests pass after plugin.py is implemented.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

_REPO_ROOT = Path(__file__).parents[4]
_PLUGIN_DIR = _REPO_ROOT / "plugins" / "ml-feature-extractor"
_PLUGIN_PATH = _PLUGIN_DIR / "plugin.py"
_SCRIPTS_DIR = _PLUGIN_DIR / "scripts"
_SDK_DIR = _REPO_ROOT / "packages" / "plugin-sdk"


def _load_plugin():
    """Load plugin.py with its scripts/ and the neurotrader_sdk on sys.path."""
    # Ensure scripts/ and SDK are importable before loading plugin.py
    for p in [str(_SCRIPTS_DIR), str(_SDK_DIR)]:
        if p not in sys.path:
            sys.path.insert(0, p)

    spec = importlib.util.spec_from_file_location("ml_plugin", str(_PLUGIN_PATH))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


def _make_ctx(config: dict[str, Any] | None = None) -> MagicMock:
    ctx = MagicMock()
    ctx.metadata = {"config": config} if config is not None else {}
    return ctx


# ---------------------------------------------------------------------------
# Helper: minimal two-class rows for a real train
# ---------------------------------------------------------------------------
def _rows(n: int = 60) -> list[dict]:
    rows = []
    for i in range(n):
        sv = json.dumps([{"plugin_id": "skill-a", "action": "buy", "confidence": 0.7}])
        rows.append(
            {
                "id": f"r{i}",
                "cycle_id": "c1",
                "symbol": "AAPL",
                "skill_vector": sv,
                "action": "buy",
                "outcome_pnl": 1.0 if i % 2 == 0 else -1.0,
                "active_skill_hash": "abc",
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Phase 4.1 — plugin.train delegates to model.train
# ---------------------------------------------------------------------------
def test_plugin_train_delegates(plugin):
    """plugin.train(training_data=rows, _context=ctx) must delegate to model.train."""
    ctx = _make_ctx({"model_type": "logreg", "min_samples": 50})
    rows = _rows(60)

    result = plugin.train(training_data=rows, _context=ctx)

    assert isinstance(result, dict)
    assert result["ok"] is True
    assert result["status"] in ("trained", "cold_start")


def test_plugin_train_trained_result(plugin):
    """With 60 two-class rows and default config, plugin.train must return status='trained'."""
    ctx = _make_ctx({"model_type": "logreg", "min_samples": 50})
    rows = _rows(60)

    result = plugin.train(training_data=rows, _context=ctx)
    assert result["status"] == "trained"
    assert result["model_blob"] is not None


# ---------------------------------------------------------------------------
# Phase 4.2 — plugin.predict delegates to model.predict
# ---------------------------------------------------------------------------
def test_plugin_predict_delegates(plugin):
    """plugin.predict(signals=sigs, model_blob=None, _context=ctx) must delegate."""
    ctx = _make_ctx()
    signals = [{"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8}]

    result = plugin.predict(signals=signals, model_blob=None, _context=ctx)

    assert isinstance(result, dict)
    assert result["ok"] is True
    assert result["multipliers"] == {}


def test_plugin_predict_with_blob(plugin):
    """Train a real blob via plugin.train, then pass it to plugin.predict."""
    ctx = _make_ctx({"model_type": "logreg", "min_samples": 50})
    rows = _rows(60)
    train_result = plugin.train(training_data=rows, _context=ctx)
    assert train_result["status"] == "trained"
    blob = train_result["model_blob"]

    signals = [{"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8}]
    pred_result = plugin.predict(signals=signals, model_blob=blob, _context=ctx)

    assert pred_result["ok"] is True
    assert "skill-a|AAPL" in pred_result["multipliers"]
    m = pred_result["multipliers"]["skill-a|AAPL"]
    assert 0.5 <= m <= 1.5


# ---------------------------------------------------------------------------
# Phase 4.3 — config defaults when _context is None
# ---------------------------------------------------------------------------
def test_plugin_config_defaults(plugin):
    """_context=None must not raise; model defaults are applied."""
    rows = _rows(60)
    result = plugin.train(training_data=rows, _context=None)
    # Must not raise; result is valid
    assert isinstance(result, dict)
    assert result["ok"] is True


def test_plugin_predict_config_defaults_none_ctx(plugin):
    """predict with _context=None and no blob must return identity without error."""
    signals = [{"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.5}]
    result = plugin.predict(signals=signals, model_blob=None, _context=None)
    assert result["ok"] is True
    assert result["multipliers"] == {}
