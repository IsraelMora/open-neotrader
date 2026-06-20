"""
on_cycle hook — ML Feature Extractor (s3).

Reads pending_signals and model_blob from ctx, calls predict() to get
per-signal confidence multipliers, and applies them in-place.

Contract:
  - No model_blob → return ctx unchanged (identity). NEVER raises.
  - model_blob present → call predict(); multiply each signal's confidence
    by its multiplier (key = '{plugin_id}|{symbol}', default 1.0 if absent).
  - Clamp adjusted confidence to [0.0, 1.0].
  - ONLY confidence is mutated. symbol, action, and all other fields are
    UNCHANGED. No signal is added or removed.
  - Any exception inside the body → return ctx unchanged (identity).
  - Called by the kernel BEFORE signal-aggregator (s3 D1 sort guarantees
    ordering); the aggregator votes on already-adjusted confidences.
"""
from __future__ import annotations

import json
import os
import sys

# Make scripts/ importable without the runner's sys.path manipulation.
# Mirrors signal-aggregator/hooks/cycle.py → ../scripts pattern.
_PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PLUGIN_DIR)

from scripts.model import predict as _predict_from_model  # noqa: E402


# ---------------------------------------------------------------------------
# Internal helper (pure, extracted for clarity — task 2.3 refactor)
# ---------------------------------------------------------------------------

def _apply_multipliers(signals: list[dict], multipliers: dict[str, float]) -> list[dict]:
    """
    Apply per-signal multipliers to the confidence field in-place.

    For each signal:
      key = f"{signal.get('plugin_id') or signal.get('source', '')}|{signal['symbol']}"
      multiplier = multipliers.get(key, 1.0)
      signal['confidence'] = clamp(float(confidence) * multiplier, 0.0, 1.0)

    Only confidence is mutated. All other fields are preserved.
    Signals where key lookup fails or confidence is missing use multiplier 1.0 (identity).
    """
    for sig in signals:
        if not isinstance(sig, dict):
            continue
        # Key parity with s2 predict() output: '{plugin_id}|{symbol}' (D5)
        plugin_id = sig.get("plugin_id") or sig.get("source") or ""
        symbol = sig.get("symbol", "")
        key = f"{plugin_id}|{symbol}"
        m = multipliers.get(key, 1.0)
        try:
            conf = float(sig.get("confidence", 0.0))
        except (TypeError, ValueError):
            conf = 0.0
        sig["confidence"] = max(0.0, min(1.0, conf * m))
    return signals


# ---------------------------------------------------------------------------
# Hook entry point
# ---------------------------------------------------------------------------

def on_cycle(ctx: dict) -> dict:
    """
    Adjust pending_signals.confidence via ML predict() multipliers.

    Identity conditions (return ctx unchanged, no raise):
      - ctx.get('model_blob') is falsy
      - predict() raises
      - any other exception

    Mutation:
      - ctx['pending_signals'] confidences scaled by per-signal multipliers
        from predict(); clamped to [0.0, 1.0]; no other field changed.
    """
    try:
        model_blob = ctx.get("model_blob")
        if not model_blob:
            return ctx

        pending_signals = ctx.get("pending_signals") or []
        if not isinstance(pending_signals, list):
            return ctx

        # Config for predict() — runner merges manifest [config] defaults into ctx
        # for discipline hooks (cmd_run_hook L384-391), so ctx['config'] is available.
        cfg = ctx.get("config") or {}

        predict_result = _predict_from_model(
            signals=pending_signals,
            model_blob=model_blob,
            config=cfg,
        )
        multipliers: dict[str, float] = predict_result.get("multipliers") or {}

        _apply_multipliers(pending_signals, multipliers)
        ctx["pending_signals"] = pending_signals
        return ctx

    except Exception:  # noqa: BLE001
        # Identity: return ctx unchanged on any error; cycle MUST NOT be broken.
        return ctx


if __name__ == "__main__":
    import sys as _sys

    _ctx = json.loads(_sys.stdin.read())
    print(json.dumps(on_cycle(_ctx)))
