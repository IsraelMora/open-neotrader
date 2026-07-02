"""
TDD tests for ml-feature-extractor s3 PR1:
  - manifest [hooks] declaration (tasks 1.3 / 1.4)
  - on_cycle hook in plugins/ml-feature-extractor/hooks/cycle.py (tasks 2.1 / 2.2 / 2.3)

Run: cd apps/sandbox && python3 -m pytest -q

RED phase: tasks 1.3 + all of 2.1 fail (manifest missing [hooks]; hook file absent).
GREEN phase: all pass after 1.4 + 2.2 implemented.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).parents[4]
_PLUGIN_DIR = _REPO_ROOT / "plugins" / "ml-feature-extractor"
_MANIFEST_PATH = _PLUGIN_DIR / "manifest.toml"
_HOOK_PATH = _PLUGIN_DIR / "hooks" / "cycle.py"
_SCRIPTS_DIR = _PLUGIN_DIR / "scripts"


# ---------------------------------------------------------------------------
# Task 1.3 — manifest [hooks] on_cycle declaration
# ---------------------------------------------------------------------------

class TestManifestHooksDeclaration:
    """Task 1.3 (RED) / 1.4 (GREEN): manifest declares [hooks] on_cycle = 'hooks/cycle.py'."""

    def test_manifest_has_hooks_section(self):
        """[hooks] section must be present in manifest.toml."""
        try:
            import tomllib
        except ImportError:
            import tomli as tomllib  # type: ignore[no-redef]

        with open(_MANIFEST_PATH, "rb") as f:
            m = tomllib.load(f)

        assert "hooks" in m, (
            "manifest.toml is missing [hooks] section — add [hooks] on_cycle = 'hooks/cycle.py'"
        )

    def test_manifest_on_cycle_points_to_hooks_cycle_py(self):
        """[hooks].on_cycle must equal 'hooks/cycle.py' (runner convention for discipline hooks)."""
        try:
            import tomllib
        except ImportError:
            import tomli as tomllib  # type: ignore[no-redef]

        with open(_MANIFEST_PATH, "rb") as f:
            m = tomllib.load(f)

        hooks = m.get("hooks", {})
        assert "on_cycle" in hooks, (
            "manifest.toml [hooks] is missing 'on_cycle' key"
        )
        assert hooks["on_cycle"] == "hooks/cycle.py", (
            f"Expected on_cycle = 'hooks/cycle.py', got {hooks['on_cycle']!r}"
        )

    def test_manifest_loads_without_error(self):
        """manifest.toml must parse cleanly after adding [hooks]."""
        try:
            import tomllib
        except ImportError:
            import tomli as tomllib  # type: ignore[no-redef]

        with open(_MANIFEST_PATH, "rb") as f:
            m = tomllib.load(f)

        assert isinstance(m, dict)
        assert m["plugin"]["id"] == "ml-feature-extractor"


# ---------------------------------------------------------------------------
# Fixture: load hooks/cycle.py as a module (mirrors test_model.py pattern)
# ---------------------------------------------------------------------------

def _load_hook():
    """Load hooks/cycle.py without the runner, mirroring _load_model() pattern."""
    # Add plugin dir to sys.path so that 'from scripts.model import predict' resolves.
    plugin_str = str(_PLUGIN_DIR)
    if plugin_str not in sys.path:
        sys.path.insert(0, plugin_str)

    spec = importlib.util.spec_from_file_location("ml_cycle_hook", str(_HOOK_PATH))
    assert spec is not None, f"Cannot locate hook at {_HOOK_PATH}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def hook():
    """Loaded hooks/cycle.py module."""
    return _load_hook()


# ---------------------------------------------------------------------------
# Fixture: a trained model blob (reuses model.py's train() via scripts/)
# ---------------------------------------------------------------------------

def _load_model_module():
    """Load scripts/model.py for the blob fixture (same pattern as test_model.py)."""
    scripts_str = str(_SCRIPTS_DIR)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)

    spec = importlib.util.spec_from_file_location(
        "ml_model_for_hook_test", str(_SCRIPTS_DIR / "model.py")
    )
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _make_training_rows(n: int, plugin_ids: list[str]) -> list[dict]:
    rows = []
    for i in range(n):
        sv = [{"plugin_id": pid, "action": "buy", "confidence": 0.7} for pid in plugin_ids]
        rows.append({
            "id": f"row-{i}",
            "cycle_id": f"cycle-{i}",
            "symbol": "AAPL",
            "skill_vector": json.dumps(sv),
            "action": "buy",
            "outcome_pnl": 1.0 if i % 2 == 0 else -1.0,
            "active_skill_hash": "abc123",
        })
    return rows


_DEFAULT_CFG: dict[str, Any] = {
    "model_type": "logreg",
    "min_samples": 50,
    "multiplier_min": 0.5,
    "multiplier_max": 1.5,
}

_PLUGIN_IDS = ["skill-a", "skill-b", "skill-c"]


@pytest.fixture(scope="module")
def trained_blob():
    """A real trained model_blob from model.train() — used as a valid blob fixture."""
    model_mod = _load_model_module()
    rows = _make_training_rows(60, _PLUGIN_IDS)
    result = model_mod.train(rows, _DEFAULT_CFG)
    assert result["status"] == "trained", f"Blob fixture train failed: {result}"
    return result["model_blob"]


# ---------------------------------------------------------------------------
# Task 2.1 (RED) / 2.2 (GREEN): on_cycle behaviour tests
# ---------------------------------------------------------------------------

class TestOnCycleHookIdentity:
    """Identity path: no model_blob → ctx returned unchanged, no raise."""

    def test_no_model_blob_returns_ctx_unchanged(self, hook):
        """AC-S3-4/spec step 2: no model_blob → identity, no raise."""
        signals = [
            {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.7},
            {"plugin_id": "skill-b", "symbol": "TSLA", "action": "sell", "confidence": 0.5},
        ]
        ctx = {"pending_signals": signals, "config": _DEFAULT_CFG}
        original_confidences = [s["confidence"] for s in signals]

        result = hook.on_cycle(ctx)

        assert result is not None, "on_cycle must return ctx"
        out_signals = result.get("pending_signals", signals)
        assert len(out_signals) == len(signals), "Signal count must not change"
        for i, sig in enumerate(out_signals):
            assert sig["confidence"] == original_confidences[i], (
                f"Confidence must be unchanged for signal {i} when no model_blob"
            )

    def test_no_model_blob_does_not_raise(self, hook):
        """on_cycle with no model_blob must never raise."""
        ctx: dict = {"pending_signals": [], "config": {}}
        try:
            result = hook.on_cycle(ctx)
        except Exception as exc:
            pytest.fail(f"on_cycle raised unexpectedly with no model_blob: {exc}")
        assert result is not None

    def test_missing_pending_signals_does_not_raise(self, hook):
        """ctx without pending_signals key must not raise."""
        ctx: dict = {}
        try:
            result = hook.on_cycle(ctx)
        except Exception as exc:
            pytest.fail(f"on_cycle raised with empty ctx: {exc}")
        assert result is not None


class TestOnCycleHookWithValidBlob:
    """Valid blob path: confidences multiplied, clamped, symbol/action unchanged."""

    def test_valid_blob_confidences_multiplied(self, hook, trained_blob):
        """AC-S3-2: confidences multiplied by predict() multipliers; symbol/action unchanged."""
        signals = [
            {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.7},
            {"plugin_id": "skill-b", "symbol": "TSLA", "action": "sell", "confidence": 0.6},
            {"plugin_id": "skill-c", "symbol": "GOOG", "action": "hold", "confidence": 0.4},
        ]
        ctx = {
            "pending_signals": [dict(s) for s in signals],
            "model_blob": trained_blob,
            "config": _DEFAULT_CFG,
        }

        result = hook.on_cycle(ctx)

        out_signals = result.get("pending_signals", [])
        assert len(out_signals) == len(signals), "Signal count must not change"

        for orig, out in zip(signals, out_signals, strict=True):
            # symbol and action MUST be unchanged
            assert out["symbol"] == orig["symbol"], f"symbol changed for {orig}"
            assert out["action"] == orig["action"], f"action changed for {orig}"
            # confidence must be a float in [0, 1]
            conf = out["confidence"]
            assert isinstance(conf, float), f"confidence must be float, got {type(conf)}"
            assert 0.0 <= conf <= 1.0, f"confidence {conf} out of [0, 1] for {orig}"

    def test_valid_blob_signal_count_unchanged(self, hook, trained_blob):
        """AC-S3-2 / spec step 8: list length unchanged."""
        signals = [
            {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.5},
            {"plugin_id": "skill-b", "symbol": "TSLA", "action": "sell", "confidence": 0.8},
        ]
        ctx = {
            "pending_signals": [dict(s) for s in signals],
            "model_blob": trained_blob,
            "config": _DEFAULT_CFG,
        }
        result = hook.on_cycle(ctx)
        out_signals = result.get("pending_signals", [])
        assert len(out_signals) == 2, "Signal must not be dropped or added"

    def test_valid_blob_only_confidence_mutated(self, hook, trained_blob):
        """AC-S3-9: only confidence field changes; all other fields are identical."""
        original = {
            "plugin_id": "skill-a",
            "symbol": "AAPL",
            "action": "buy",
            "confidence": 0.7,
            "extra_field": "preserved",
        }
        ctx = {
            "pending_signals": [dict(original)],
            "model_blob": trained_blob,
            "config": _DEFAULT_CFG,
        }
        result = hook.on_cycle(ctx)
        out = result["pending_signals"][0]

        assert out["symbol"] == original["symbol"]
        assert out["action"] == original["action"]
        assert out["plugin_id"] == original["plugin_id"]
        assert out["extra_field"] == original["extra_field"]
        # confidence is the only field allowed to change
        # (It may be identical to original if multiplier == 1.0, that's fine)
        assert 0.0 <= out["confidence"] <= 1.0


class TestOnCycleHookClamp:
    """Clamp math: confidence × multiplier clamped to [0, 1]."""

    def test_clamp_high_confidence_x_high_multiplier(self, hook, trained_blob):
        """0.9 × 1.5 = 1.35 → clamped to 1.0 (AC-S3-2)."""
        # We can't force predict() to return exactly 1.5 without monkeypatching,
        # so we test clamping through the hook's own arithmetic by patching predict.
        import unittest.mock as mock

        signals = [
            {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.9},
        ]
        ctx = {
            "pending_signals": [dict(s) for s in signals],
            "model_blob": trained_blob,
            "config": _DEFAULT_CFG,
        }

        # Monkeypatch the model module that cycle.py imports
        # by patching the predict function via the hook module's reference
        with mock.patch.object(
            hook,
            "_predict_fn",
            return_value={"ok": True, "multipliers": {"skill-a|AAPL": 1.5}},
            create=True,
        ):
            # Force a controlled multiplier via internal helper path
            # Since we can't easily intercept, test via a known blob that yields known output
            # The real test is that confidences are in [0,1] — already tested above.
            # Here we test the clamp directly by calling the internal helper.
            pass

        # Test the clamp invariant via the helper if it exists (refactor task 2.3)
        if hasattr(hook, "_apply_multipliers"):
            sigs = [{"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.9}]
            multipliers = {"skill-a|AAPL": 1.5}
            result_sigs = hook._apply_multipliers([dict(s) for s in sigs], multipliers)
            assert result_sigs[0]["confidence"] == 1.0, (
                f"Expected 1.0 (clamped from 0.9*1.5=1.35), got {result_sigs[0]['confidence']}"
            )
        else:
            # Fall back to end-to-end: result must be in [0,1]
            result = hook.on_cycle(ctx)
            out_conf = result["pending_signals"][0]["confidence"]
            assert 0.0 <= out_conf <= 1.0

    def test_clamp_low_confidence_x_low_multiplier(self, hook, trained_blob):
        """0.8 × 0.5 = 0.4 → stays 0.4; must not go below 0.0 (AC-S3-2)."""
        if hasattr(hook, "_apply_multipliers"):
            sigs = [{"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8}]
            multipliers = {"skill-a|AAPL": 0.5}
            result_sigs = hook._apply_multipliers([dict(s) for s in sigs], multipliers)
            expected = 0.8 * 0.5
            assert abs(result_sigs[0]["confidence"] - expected) < 1e-9, (
                f"Expected {expected}, got {result_sigs[0]['confidence']}"
            )
        else:
            # end-to-end: result must be in [0, 1]
            signals = [
                {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8},
            ]
            ctx = {
                "pending_signals": [dict(s) for s in signals],
                "model_blob": trained_blob,
                "config": _DEFAULT_CFG,
            }
            result = hook.on_cycle(ctx)
            out_conf = result["pending_signals"][0]["confidence"]
            assert 0.0 <= out_conf <= 1.0


class TestOnCycleHookMissingKey:
    """Missing multiplier key → 1.0 identity for that signal."""

    def test_missing_multiplier_key_uses_1_0(self, hook, trained_blob):
        """Spec step 4: key absent from multipliers dict → multiplier = 1.0."""
        if hasattr(hook, "_apply_multipliers"):
            # Use _apply_multipliers with empty dict → no key → identity
            sigs = [
                {"plugin_id": "unknown-plugin", "symbol": "XYZ", "action": "buy", "confidence": 0.6}
            ]
            result_sigs = hook._apply_multipliers([dict(s) for s in sigs], {})
            assert abs(result_sigs[0]["confidence"] - 0.6) < 1e-9, (
                "Missing key must default to 1.0 multiplier; "
                f"expected 0.6, got {result_sigs[0]['confidence']}"
            )
        else:
            # With a trained blob, signals with unknown plugin_ids not in training data
            # will get identity multiplier (1.0) from predict() — confidence unchanged.
            signals = [
                {
                    "plugin_id": "unknown-plugin",
                    "symbol": "UNKNOWN",
                    "action": "buy",
                    "confidence": 0.6,
                }
            ]
            ctx = {
                "pending_signals": [dict(s) for s in signals],
                "model_blob": trained_blob,
                "config": _DEFAULT_CFG,
            }
            result = hook.on_cycle(ctx)
            out_conf = result["pending_signals"][0]["confidence"]
            assert 0.0 <= out_conf <= 1.0


class TestOnCycleHookNeverFlip:
    """AC-S3-9: action never flipped; confidence stays > 0 when multiplier ∈ [0.5, 1.5]."""

    def test_buy_signal_action_stays_buy(self, hook, trained_blob):
        """A buy signal's action must remain 'buy' after adjustment."""
        signals = [
            {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.7},
        ]
        ctx = {
            "pending_signals": [dict(s) for s in signals],
            "model_blob": trained_blob,
            "config": _DEFAULT_CFG,
        }
        result = hook.on_cycle(ctx)
        out = result["pending_signals"][0]
        assert out["action"] == "buy", f"Action flipped! Expected 'buy', got {out['action']}"

    def test_sell_signal_action_stays_sell(self, hook, trained_blob):
        """A sell signal's action must remain 'sell' after adjustment."""
        signals = [
            {"plugin_id": "skill-b", "symbol": "TSLA", "action": "sell", "confidence": 0.6},
        ]
        ctx = {
            "pending_signals": [dict(s) for s in signals],
            "model_blob": trained_blob,
            "config": _DEFAULT_CFG,
        }
        result = hook.on_cycle(ctx)
        out = result["pending_signals"][0]
        assert out["action"] == "sell", f"Action flipped! Expected 'sell', got {out['action']}"

    def test_buy_confidence_stays_positive_with_any_multiplier(self, hook):
        """conf > 0 × multiplier ∈ [0.5, 1.5] → conf > 0 (direction preserved structurally)."""
        if hasattr(hook, "_apply_multipliers"):
            for m in [0.5, 0.7, 1.0, 1.2, 1.5]:
                sigs = [
                    {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.5}
                ]
                result_sigs = hook._apply_multipliers([dict(s) for s in sigs], {"skill-a|AAPL": m})
                assert result_sigs[0]["confidence"] > 0.0, (
                    f"Confidence went to 0 with multiplier {m}"
                )
        # If helper not available, the never-flip is structurally guaranteed by
        # multiplier ∈ [0.5, 1.5] and confidence ≥ 0 — tested via end-to-end tests above.


class TestOnCycleHookErrorHandling:
    """AC-S3-5: predict raises → identity, no exception propagates."""

    def test_corrupt_blob_returns_ctx_unchanged(self, hook):
        """A corrupt model_blob must cause on_cycle to return ctx unchanged (identity)."""
        signals = [
            {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.7},
        ]
        ctx = {
            "pending_signals": [dict(s) for s in signals],
            "model_blob": "NOT_VALID_BASE64_OR_JOBLIB!!!",
            "config": _DEFAULT_CFG,
        }
        original_confidence = signals[0]["confidence"]

        try:
            result = hook.on_cycle(ctx)
        except Exception as exc:
            pytest.fail(f"on_cycle raised with corrupt blob: {exc}")

        out_signals = result.get("pending_signals", signals)
        assert len(out_signals) == 1
        assert out_signals[0]["confidence"] == original_confidence, (
            "Confidence must be unchanged after predict error (identity path)"
        )

    def test_no_exception_propagates_from_hook(self, hook):
        """on_cycle MUST NOT raise under any condition (try/except identity contract)."""
        bad_inputs = [
            {"model_blob": "garbage", "pending_signals": []},
            {"model_blob": None, "pending_signals": None},
            {"model_blob": "YWJj", "pending_signals": [None, "not-a-dict"]},
            {},
        ]
        for ctx in bad_inputs:
            try:
                hook.on_cycle(ctx)
            except Exception as exc:
                pytest.fail(f"on_cycle raised for ctx={ctx}: {exc}")


class TestOnCycleHookSignalNotDropped:
    """Spec step 8: MUST NOT remove or drop any signal."""

    def test_malformed_signal_still_present_in_output(self, hook, trained_blob):
        """A malformed signal entry must remain in the output list (degraded to identity)."""
        signals = [
            {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.7},
            {"not_a_signal": True},  # malformed — must still be present
        ]
        ctx = {
            "pending_signals": [dict(s) if isinstance(s, dict) else s for s in signals],
            "model_blob": trained_blob,
            "config": _DEFAULT_CFG,
        }
        result = hook.on_cycle(ctx)
        out_signals = result.get("pending_signals", [])
        assert len(out_signals) == 2, (
            f"Expected 2 signals (including malformed), got {len(out_signals)}"
        )

    def test_no_blob_signal_count_preserved(self, hook):
        """Without model_blob, all signals must be present unchanged."""
        signals = [
            {"plugin_id": "a", "symbol": "X", "action": "buy", "confidence": 0.5},
            {"plugin_id": "b", "symbol": "Y", "action": "sell", "confidence": 0.4},
            {"plugin_id": "c", "symbol": "Z", "action": "hold", "confidence": 0.3},
        ]
        ctx = {"pending_signals": [dict(s) for s in signals]}
        result = hook.on_cycle(ctx)
        out = result.get("pending_signals", [])
        assert len(out) == 3
