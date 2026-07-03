"""
ml-feature-extractor — thin @skill adapter wrappers over scripts/model.py.

Args arrive as kwargs because runner.py does fn(**args, _context=ctx).
Config is read from _context.metadata (cmd_call_plugin does NOT auto-merge
manifest [config] defaults — design D4). Defaults are duplicated from model.py.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make scripts/ importable without requiring the runner's sys.path manipulation
sys.path.insert(0, str(Path(__file__).parent / "scripts"))

from model import predict as _predict  # noqa: E402
from model import train as _train  # noqa: E402
from neurotrader_sdk import Context, skill  # noqa: E402


def _cfg(ctx: Context | None) -> dict:
    """Extract config dict from context metadata; empty dict triggers model defaults."""
    return (getattr(ctx, "metadata", {}) or {}).get("config", {}) or {}


@skill(
    name="train",
    description=(
        "Train on-device sklearn model from labeled signal history. "
        "Returns a base64 model blob. Cold-starts if insufficient data."
    ),
)
def train(
    training_data: list | None = None,
    *,
    _context: Context | None = None,
) -> dict:
    return _train(training_data or [], _cfg(_context))


@skill(
    name="predict",
    description=(
        "Return per-signal confidence multipliers in [multiplier_min, multiplier_max]. "
        "Identity (empty dict) when no model blob is provided or on any error."
    ),
)
def predict(
    signals: list | None = None,
    model_blob: str | None = None,
    *,
    _context: Context | None = None,
) -> dict:
    return _predict(signals or [], model_blob, _cfg(_context))
