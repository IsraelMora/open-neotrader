"""
TDD tests for plugins/ml-feature-extractor/scripts/model.py.

All tests are PURE — no runner/Context dependency.
Run: cd apps/sandbox && python3 -m pytest -q

RED phase: all tests fail because model.py does not exist yet.
GREEN phase: tests pass after model.py is implemented.
"""
from __future__ import annotations

import base64
import builtins
import hashlib
import importlib
import importlib.util
import io
import json
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Import model.py directly from scripts/ (no runner, no SDK dependency)
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = Path(__file__).parents[4] / "plugins" / "ml-feature-extractor" / "scripts"


def _load_model():
    """Load model.py as a fresh module from the scripts directory."""
    spec = importlib.util.spec_from_file_location(
        "ml_model",
        str(_SCRIPTS_DIR / "model.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def model():
    return _load_model()


# ---------------------------------------------------------------------------
# Helpers to build minimal training rows
# ---------------------------------------------------------------------------
def _make_rows(n: int, plugin_ids: list[str], two_class: bool = True) -> list[dict]:
    """
    Build n synthetic MlSignalRow-like dicts for testing.
    skill_vector is a JSON string: [{plugin_id, action, confidence}, ...]
    outcome_pnl alternates sign (two_class=True) or is always +1 (single class).
    """
    rows = []
    for i in range(n):
        sv = [
            {"plugin_id": pid, "action": "buy", "confidence": 0.7}
            for pid in plugin_ids
        ]
        pnl = (1.0 if i % 2 == 0 else -1.0) if two_class else 1.0
        rows.append(
            {
                "id": f"row-{i}",
                "cycle_id": f"cycle-{i}",
                "symbol": "AAPL",
                "skill_vector": json.dumps(sv),
                "action": "buy",
                "outcome_pnl": pnl,
                "active_skill_hash": hashlib.sha256(
                    ",".join(sorted(plugin_ids)).encode()
                ).hexdigest()[:16],
            }
        )
    return rows


DEFAULT_CFG: dict[str, Any] = {
    "model_type": "logreg",
    "min_samples": 50,
    "multiplier_min": 0.5,
    "multiplier_max": 1.5,
}


# ---------------------------------------------------------------------------
# Phase 2.1 — train cold_start: < min_samples rows
# ---------------------------------------------------------------------------
def test_train_cold_start(model):
    rows = _make_rows(49, ["skill-a", "skill-b"])
    result = model.train(rows, DEFAULT_CFG)
    assert result["ok"] is True
    assert result["status"] == "cold_start"
    assert result["model_blob"] is None


# ---------------------------------------------------------------------------
# Phase 2.2 — train cold_start: single-class y (all positive)
# ---------------------------------------------------------------------------
def test_train_single_class_cold_start(model):
    rows = _make_rows(60, ["skill-a", "skill-b"], two_class=False)
    result = model.train(rows, DEFAULT_CFG)
    assert result["ok"] is True
    assert result["status"] == "cold_start"
    assert result["model_blob"] is None


# ---------------------------------------------------------------------------
# Phase 2.3 — train trained: ≥ min_samples, two-class, logreg
# ---------------------------------------------------------------------------
def test_train_trained_logreg(model):
    import joblib
    from sklearn.linear_model import LogisticRegression

    rows = _make_rows(60, ["skill-a", "skill-b", "skill-c"])
    result = model.train(rows, DEFAULT_CFG)

    assert result["ok"] is True
    assert result["status"] == "trained"
    assert result["model_blob"] is not None
    assert isinstance(result["model_blob"], str)
    assert result["n_samples"] == 60
    assert isinstance(result["feature_names"], list)
    assert len(result["feature_names"]) > 0
    # active_skill_hash must be 16 hex chars
    assert isinstance(result["active_skill_hash"], str)
    assert len(result["active_skill_hash"]) == 16

    # Blob must decode to a fitted LogisticRegression
    blob_bytes = base64.b64decode(result["model_blob"])
    obj = joblib.load(io.BytesIO(blob_bytes))
    assert isinstance(obj["model"], LogisticRegression)
    assert obj["feature_names"] == result["feature_names"]


# ---------------------------------------------------------------------------
# Phase 2.4 — train trained: rf model_type
# ---------------------------------------------------------------------------
def test_train_trained_rf(model):
    import joblib
    from sklearn.ensemble import RandomForestClassifier

    cfg = {**DEFAULT_CFG, "model_type": "rf"}
    rows = _make_rows(60, ["skill-a", "skill-b"])
    result = model.train(rows, cfg)

    assert result["ok"] is True
    assert result["status"] == "trained"
    assert result["model_blob"] is not None

    blob_bytes = base64.b64decode(result["model_blob"])
    obj = joblib.load(io.BytesIO(blob_bytes))
    assert isinstance(obj["model"], RandomForestClassifier)


# ---------------------------------------------------------------------------
# Phase 2.5 — train NO file writes (monkeypatch builtins.open write mode)
# ---------------------------------------------------------------------------
def test_train_no_file_write(model, tmp_path, monkeypatch):
    import joblib

    write_attempted = []
    original_open = builtins._nt_original_open if hasattr(builtins, "_nt_original_open") else open

    def _open_sentinel(file, mode="r", *args, **kwargs):
        if isinstance(file, (str, Path, bytes)) and any(m in mode for m in ("w", "a", "x")):
            write_attempted.append(str(file))
            raise PermissionError(f"[test-sentinel] write blocked: {file!r}")
        return original_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", _open_sentinel)

    rows = _make_rows(60, ["skill-a", "skill-b"])
    result = model.train(rows, DEFAULT_CFG)

    # Must succeed with no writes
    assert result["status"] == "trained"
    assert result["model_blob"] is not None
    assert write_attempted == [], f"Unexpected file writes: {write_attempted}"

    # Blob must round-trip via base64 + BytesIO + joblib.load
    blob_bytes = base64.b64decode(result["model_blob"])
    obj = joblib.load(io.BytesIO(blob_bytes))
    assert obj["model"] is not None


# ---------------------------------------------------------------------------
# Phase 2.6 — train never throws on garbage input
# ---------------------------------------------------------------------------
def test_train_never_throws(model):
    """Malformed / None training data must return cold_start, not raise."""
    for garbage in [None, [], [None], [{"bad": "row"}], "not-a-list", 42]:
        result = model.train(garbage, DEFAULT_CFG)
        assert result["ok"] is True, f"Expected ok=True for input {garbage!r}"
        assert result["status"] == "cold_start", f"Expected cold_start for input {garbage!r}"


# ---------------------------------------------------------------------------
# Phase 2.7 — predict identity: no blob → empty dict
# ---------------------------------------------------------------------------
def test_predict_identity_no_blob(model):
    signals = [
        {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8},
    ]
    result = model.predict(signals, None, DEFAULT_CFG)
    assert result["ok"] is True
    assert result["multipliers"] == {}


# ---------------------------------------------------------------------------
# Phase 2.8 — predict bounds: all multipliers ∈ [0.5, 1.5] and > 0
# ---------------------------------------------------------------------------
def test_predict_bounds(model):
    rows = _make_rows(60, ["skill-a", "skill-b", "skill-c"])
    train_result = model.train(rows, DEFAULT_CFG)
    assert train_result["status"] == "trained"
    blob = train_result["model_blob"]

    signals = [
        {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8},
        {"plugin_id": "skill-b", "symbol": "TSLA", "action": "sell", "confidence": 0.6},
        {"plugin_id": "skill-c", "symbol": "GOOG", "action": "hold", "confidence": 0.3},
    ]
    result = model.predict(signals, blob, DEFAULT_CFG)
    assert result["ok"] is True
    assert len(result["multipliers"]) == 3

    for key, m in result["multipliers"].items():
        assert m >= 0.5, f"Multiplier {m} below 0.5 for key {key}"
        assert m <= 1.5, f"Multiplier {m} above 1.5 for key {key}"
        assert m > 0, f"Multiplier {m} is not positive for key {key}"


# ---------------------------------------------------------------------------
# Phase 2.9 — feature ordering stable: signal order in predict doesn't matter
# ---------------------------------------------------------------------------
def test_predict_signal_order_stable(model):
    plugin_ids = ["skill-a", "skill-b", "skill-c"]
    rows = _make_rows(60, plugin_ids)
    train_result = model.train(rows, DEFAULT_CFG)
    assert train_result["status"] == "trained"
    blob = train_result["model_blob"]

    signals_original = [
        {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8},
        {"plugin_id": "skill-b", "symbol": "TSLA", "action": "sell", "confidence": 0.6},
        {"plugin_id": "skill-c", "symbol": "GOOG", "action": "buy", "confidence": 0.4},
    ]
    signals_shuffled = [
        {"plugin_id": "skill-c", "symbol": "GOOG", "action": "buy", "confidence": 0.4},
        {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8},
        {"plugin_id": "skill-b", "symbol": "TSLA", "action": "sell", "confidence": 0.6},
    ]

    result_original = model.predict(signals_original, blob, DEFAULT_CFG)
    result_shuffled = model.predict(signals_shuffled, blob, DEFAULT_CFG)

    assert result_original["ok"] is True
    assert result_shuffled["ok"] is True

    for key in result_original["multipliers"]:
        assert key in result_shuffled["multipliers"], f"Key {key} missing in shuffled result"
        m_orig = result_original["multipliers"][key]
        m_shuf = result_shuffled["multipliers"][key]
        assert abs(m_orig - m_shuf) < 1e-9, (
            f"Multiplier mismatch for {key}: original={m_orig}, shuffled={m_shuf}"
        )


# ---------------------------------------------------------------------------
# Phase 2.10 — predict never throws on corrupted blob
# ---------------------------------------------------------------------------
def test_predict_never_throws(model):
    signals = [
        {"plugin_id": "skill-a", "symbol": "AAPL", "action": "buy", "confidence": 0.8},
    ]
    corrupted_blobs = [
        "not-valid-base64!!!",
        "dmFsaWQ=",  # valid base64 but not a joblib artifact
        "",
        "AAAA",
    ]
    for blob in corrupted_blobs:
        result = model.predict(signals, blob, DEFAULT_CFG)
        assert result["ok"] is True, f"Expected ok=True for blob {blob!r}"
        assert result["multipliers"] == {}, f"Expected empty multipliers for blob {blob!r}"


# ---------------------------------------------------------------------------
# Phase 2.11 — active_skill_hash parity with s1's TS computeActiveSkillHash
#
# TS implementation (ml-signal-record.service.ts):
#   const sorted = [...ids].sort((a, b) => a.localeCompare(b)).join(',');
#   return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
#
# For ASCII plugin IDs, localeCompare == lexicographic sort == Python sorted().
# Python equivalent:
#   hashlib.sha256(','.join(sorted(ids)).encode()).hexdigest()[:16]
# ---------------------------------------------------------------------------
def test_active_skill_hash_parity(model):
    """
    Verify Python hash matches s1's TS computeActiveSkillHash for a fixed id set.

    The formula: sha256(sorted_ids_joined_by_comma)[:16_hex_chars]
    Both TS and Python use the same algorithm; we assert both against the
    hardcoded expected value derived from the same formula.
    """
    ids = ["skill-a", "skill-b", "skill-c"]

    # Expected: sha256(','.join(sorted(['skill-a', 'skill-b', 'skill-c']))) hex [:16]
    # sorted(['skill-a', 'skill-b', 'skill-c']) → ['skill-a', 'skill-b', 'skill-c']
    # joined: 'skill-a,skill-b,skill-c'
    expected = hashlib.sha256(b"skill-a,skill-b,skill-c").hexdigest()[:16]

    # Python model.py's compute_active_skill_hash must produce the same value
    result = model.compute_active_skill_hash(ids)
    assert result == expected, (
        f"Python hash {result!r} does not match expected {expected!r}"
    )

    # Also verify with a different order (must be order-independent)
    result_shuffled = model.compute_active_skill_hash(["skill-c", "skill-a", "skill-b"])
    assert result_shuffled == expected, (
        f"Python hash not order-independent: {result_shuffled!r} != {expected!r}"
    )

    # Edge case: empty id set
    empty_expected = hashlib.sha256(b"").hexdigest()[:16]
    assert model.compute_active_skill_hash([]) == empty_expected

    # Verify the hardcoded expected against the formula itself
    # (documents the cross-language contract)
    assert len(expected) == 16, "Hash must be 16 hex chars"
    assert all(c in "0123456789abcdef" for c in expected), "Hash must be lowercase hex"


# ---------------------------------------------------------------------------
# Fix 1 (CRITICAL): train() must use active_skill_hash from rows[0], NOT
# re-derive it from feature_names.
#
# Rationale: TS _mlResolveModelInjection hashes ALL active skill plugin ids
# (including skills that emitted no signals this cycle). Python re-deriving
# from feature_names only includes skills that appeared in training data,
# producing a different hash whenever a skill was signal-silent → the model
# always appears stale → the ML feature is permanently inert in production.
#
# Single source of truth: the s1-TS-captured hash stored in each training row.
# rows[0] is the most-recent row (getTrainingData returns ts DESC).
# ---------------------------------------------------------------------------

def test_train_uses_row_hash_not_feature_names_hash(model):
    """
    train() must set active_skill_hash = rows[0]['active_skill_hash'] (the
    most-recent row's TS-captured hash), NOT a recomputation from feature_names.

    RED: currently model.py re-derives the hash from real plugin_ids in
    feature_names, so when an active skill is signal-silent the hashes diverge.
    GREEN: model.py reads rows[0]['active_skill_hash'] verbatim.
    """
    # Use a realistic 16-char hash (simulating a set that includes a signal-silent skill)
    stored_hash = hashlib.sha256(b"skill-a,skill-b,skill-silent").hexdigest()[:16]
    rows = _make_rows(60, ["skill-a", "skill-b"])
    # Stamp every row with the stored_hash (as s1 capture does)
    for r in rows:
        r["active_skill_hash"] = stored_hash

    result = model.train(rows, DEFAULT_CFG)

    assert result["status"] == "trained"
    # Must echo the stored hash, NOT a recomputed one
    assert result["active_skill_hash"] == stored_hash, (
        f"Expected stored hash {stored_hash!r}, got {result['active_skill_hash']!r}. "
        "train() must use rows[0]['active_skill_hash'], not recompute from feature_names."
    )


def test_train_hash_fallback_when_row_missing_field(model):
    """
    If rows lack active_skill_hash, train() must fall back gracefully
    (None or empty string) — not crash. The TS validator's mismatch→identity
    path remains safe.
    """
    rows = _make_rows(60, ["skill-a", "skill-b"])
    for r in rows:
        r.pop("active_skill_hash", None)  # Remove the field entirely

    result = model.train(rows, DEFAULT_CFG)

    assert result["status"] == "trained"
    # Fallback must be None or '' — either is safe (TS will see mismatch → identity)
    assert result["active_skill_hash"] in (None, ""), (
        f"Expected None or '' fallback, got {result['active_skill_hash']!r}"
    )
