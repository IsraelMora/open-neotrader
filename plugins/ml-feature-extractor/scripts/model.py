"""
ml-feature-extractor — pure ML logic (no runner / SDK dependency).

SECURITY NOTE: joblib is used deliberately for sklearn model serialization via
io.BytesIO only (never a file path). The model blob is produced exclusively by
this plugin's own train() call and stored in KV as a base64 string. It is not
accepted from untrusted external sources; the kernel handler that stores/reads
the blob controls provenance. The sandbox open-guard blocks all file writes, so
BytesIO is the only viable path regardless.

This module is intentionally free of runner.py / neurotrader_sdk imports so it
can be tested directly with pytest without any sandbox machinery.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
from typing import Any

# ---------------------------------------------------------------------------
# Defaults — mirrored in manifest.toml [config] and in the kernel handler.
# If you change these, update all three locations (design R6).
# ---------------------------------------------------------------------------
_DEFAULT_MODEL_TYPE: str = "logreg"
_DEFAULT_MIN_SAMPLES: int = 50
_DEFAULT_MULTIPLIER_MIN: float = 0.5
_DEFAULT_MULTIPLIER_MAX: float = 1.5


def _cfg(config: dict[str, Any]) -> tuple[str, int, float, float]:
    """Extract and validate config values, falling back to defaults."""
    return (
        str(config.get("model_type", _DEFAULT_MODEL_TYPE)),
        int(config.get("min_samples", _DEFAULT_MIN_SAMPLES)),
        float(config.get("multiplier_min", _DEFAULT_MULTIPLIER_MIN)),
        float(config.get("multiplier_max", _DEFAULT_MULTIPLIER_MAX)),
    )


# ---------------------------------------------------------------------------
# Action encoding (shared by train and predict)
# ---------------------------------------------------------------------------
_ACTION_SIGN: dict[str, int] = {"buy": 1, "sell": -1, "hold": 0}


def _action_sign(action: str) -> int:
    return _ACTION_SIGN.get(str(action).lower(), 0)


# ---------------------------------------------------------------------------
# compute_active_skill_hash
#
# MUST be byte-identical to s1's TS computeActiveSkillHash:
#
#   const sorted = [...ids].sort((a, b) => a.localeCompare(b)).join(',');
#   return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
#
# For ASCII plugin IDs, localeCompare equals Python's default string sort
# (both are lexicographic over Unicode code points in the ASCII range).
# Python equivalent: hashlib.sha256(','.join(sorted(ids)).encode()).hexdigest()[:16]
# ---------------------------------------------------------------------------
def compute_active_skill_hash(plugin_ids: list[str]) -> str:
    """
    Stable, order-independent hash of active skill plugin IDs.
    Identical algorithm to s1's TS computeActiveSkillHash — critical for
    s3 model invalidation (hash mismatch → cold-start, no inject).

    Returns 16 lowercase hex chars (first 16 chars of SHA-256 hex digest).
    """
    joined = ",".join(sorted(plugin_ids))
    return hashlib.sha256(joined.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------

def _build_feature_row(
    parsed_sv: list[dict[str, Any]],
    feature_names: list[str],
) -> list[float]:
    """
    Build a numeric feature vector for one training/predict row.

    Feature schema (must match train() column order):
      For each plugin_id in feature_names (sorted, no reserved names):
        {plugin_id}__action_encoded  — action_sign × confidence
      n_long          — count of buy actions in this row
      n_short         — count of sell actions in this row
      agreement_ratio — max(n_long, n_short) / total_skills (0 if no skills)

    Reserved names (prefix '__', suffix '__') are skipped during hash
    computation but included in the feature vector for the model.
    """
    # Build per-skill lookup: plugin_id → action_sign × confidence
    skill_lookup: dict[str, float] = {}
    n_long = 0
    n_short = 0
    for entry in parsed_sv:
        if not isinstance(entry, dict):
            continue
        pid = str(entry.get("plugin_id", ""))
        action = str(entry.get("action", "hold")).lower()
        confidence = float(entry.get("confidence", 0.0))
        sign = _action_sign(action)
        skill_lookup[pid] = sign * confidence
        if action == "buy":
            n_long += 1
        elif action == "sell":
            n_short += 1

    total = max(len(parsed_sv), 1)
    agreement_ratio = max(n_long, n_short) / total

    row: list[float] = []
    for name in feature_names:
        if name == "__n_long__":
            row.append(float(n_long))
        elif name == "__n_short__":
            row.append(float(n_short))
        elif name == "__agreement_ratio__":
            row.append(agreement_ratio)
        else:
            # Regular plugin_id feature
            row.append(skill_lookup.get(name, 0.0))
    return row


def _parse_skill_vector(sv: Any) -> list[dict[str, Any]]:
    """Parse skill_vector field — it's a JSON string in MlSignalRow."""
    if isinstance(sv, list):
        return [e for e in sv if isinstance(e, dict)]
    if isinstance(sv, str):
        try:
            parsed = json.loads(sv)
            if isinstance(parsed, list):
                return [e for e in parsed if isinstance(e, dict)]
        except (json.JSONDecodeError, ValueError):
            pass
    return []


def _build_feature_names(rows: list[dict[str, Any]]) -> list[str]:
    """
    Collect all unique plugin_ids across training rows, sort them, then append
    reserved aggregate features. This is the stable column order stored with
    the model and used for predict alignment (design D7).
    """
    plugin_ids: set[str] = set()
    for row in rows:
        for entry in _parse_skill_vector(row.get("skill_vector", [])):
            pid = str(entry.get("plugin_id", "")).strip()
            if pid:
                plugin_ids.add(pid)
    return sorted(plugin_ids) + ["__n_long__", "__n_short__", "__agreement_ratio__"]


# ---------------------------------------------------------------------------
# train — fit model from labeled signal history
# ---------------------------------------------------------------------------

def train(training_data: Any, config: dict[str, Any]) -> dict[str, Any]:
    """
    Train an sklearn model from labeled MlSignalRecord rows.

    Returns:
        {ok, status, model_blob, n_samples, feature_names, active_skill_hash}

    Cold-start conditions:
        - training_data is None / not a list
        - len(rows) < min_samples
        - y has only one class (logreg/rf cannot fit)

    Fail-soft: any exception returns {ok: True, status: "cold_start", model_blob: None}.
    NEVER raises.
    """
    _cold: dict[str, Any] = {
        "ok": True,
        "status": "cold_start",
        "model_blob": None,
        "n_samples": 0,
        "feature_names": None,
        "active_skill_hash": None,
    }

    try:
        model_type, min_samples, mmin, mmax = _cfg(config or {})

        # Validate input
        if not isinstance(training_data, list):
            return _cold

        rows = [r for r in training_data if isinstance(r, dict)]
        _cold["n_samples"] = len(rows)

        if len(rows) < min_samples:
            return {**_cold, "n_samples": len(rows)}

        # Build feature matrix
        feature_names = _build_feature_names(rows)
        X: list[list[float]] = []
        y: list[int] = []
        for row in rows:
            sv = _parse_skill_vector(row.get("skill_vector", []))
            feat = _build_feature_row(sv, feature_names)
            X.append(feat)
            pnl = row.get("outcome_pnl", 0.0)
            y.append(1 if (pnl is not None and float(pnl) > 0) else 0)

        # Guard: single class → logreg/rf cannot fit
        if len(set(y)) < 2:
            return {**_cold, "n_samples": len(rows)}

        # Fit model
        if model_type == "rf":
            from sklearn.ensemble import RandomForestClassifier
            clf = RandomForestClassifier(n_estimators=50, max_depth=4, random_state=42)
        else:
            from sklearn.linear_model import LogisticRegression
            clf = LogisticRegression(max_iter=1000, random_state=42)

        clf.fit(X, y)

        # Serialize — BytesIO only, NO file path (sandbox open-guard blocks writes)
        buf = io.BytesIO()
        import joblib
        joblib.dump({"model": clf, "feature_names": feature_names}, buf)
        blob = base64.b64encode(buf.getvalue()).decode()

        # Hash: use the most-recent row's TS-captured active_skill_hash verbatim.
        # rows are ordered ts DESC (getTrainingData contract), so rows[0] is newest.
        # Single source of truth = s1-TS-captured hash (over ALL active skill ids,
        # including skills that were signal-silent). Re-deriving from feature_names
        # would exclude signal-silent skills and produce a different hash than TS,
        # making the model always appear stale (_mlResolveModelInjection mismatch).
        active_skill_hash = rows[0].get("active_skill_hash") or None

        return {
            "ok": True,
            "status": "trained",
            "model_blob": blob,
            "n_samples": len(rows),
            "feature_names": feature_names,
            "active_skill_hash": active_skill_hash,
        }

    except Exception as exc:  # noqa: BLE001
        return {
            "ok": True,
            "status": "cold_start",
            "model_blob": None,
            "n_samples": 0,
            "feature_names": None,
            "active_skill_hash": None,
            "error": str(exc),
        }


# ---------------------------------------------------------------------------
# predict — return per-signal confidence multipliers
# ---------------------------------------------------------------------------

def predict(
    signals: Any,
    model_blob: str | None,
    config: dict[str, Any],
) -> dict[str, Any]:
    """
    Return per-signal confidence multipliers in [multiplier_min, multiplier_max].

    If model_blob is None/absent → identity: {ok: True, multipliers: {}}.
    Caller treats a missing key as 1.0 (no adjustment).

    Fail-soft: any exception returns identity. NEVER raises.

    SECURITY: joblib.load is used on a blob produced exclusively by this
    plugin's own train() and stored in KV by the kernel handler. Provenance
    is controlled; external untrusted blobs should not reach this function.
    """
    _identity: dict[str, Any] = {"ok": True, "multipliers": {}}

    try:
        if not model_blob:
            return _identity

        _, _, mmin, mmax = _cfg(config or {})

        # Deserialize — BytesIO only (design D3)
        import joblib
        buf = io.BytesIO(base64.b64decode(model_blob))
        obj = joblib.load(buf)
        clf = obj["model"]
        feature_names: list[str] = obj["feature_names"]

        if not isinstance(signals, list) or not signals:
            return _identity

        # Build feature matrix: one row per signal
        keys: list[str] = []
        X: list[list[float]] = []
        for sig in signals:
            if not isinstance(sig, dict):
                continue
            pid = str(sig.get("plugin_id", ""))
            symbol = str(sig.get("symbol", ""))
            key = f"{pid}|{symbol}"

            # Single-signal skill_vector: just this signal's contribution
            sv = [
                {
                    "plugin_id": pid,
                    "action": sig.get("action", "hold"),
                    "confidence": float(sig.get("confidence", 0.0)),
                }
            ]
            feat = _build_feature_row(sv, feature_names)
            keys.append(key)
            X.append(feat)

        if not X:
            return _identity

        # predict_proba[:, 1] = P(profitable)
        proba = clf.predict_proba(X)
        # class_1_idx: find index of class label 1 in clf.classes_
        classes = list(clf.classes_)
        idx = classes.index(1) if 1 in classes else -1

        multipliers: dict[str, float] = {}
        for i, key in enumerate(keys):
            p = float(proba[i][idx]) if idx >= 0 else 0.5
            m = mmin + p * (mmax - mmin)
            # Clamp to [mmin, mmax] — guarantees > 0 with default bounds [0.5, 1.5]
            m = max(mmin, min(mmax, m))
            multipliers[key] = m

        return {"ok": True, "multipliers": multipliers}

    except Exception:  # noqa: BLE001
        return _identity
