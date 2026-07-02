"""
Tests for the consolidated 'universe' plugin.

Contract: on_activate(ctx) -> {"ok": True, "universe": [...], "count": N, "message": "..."}
Config key: markets (list of strings) — selects which curated lists to include.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers to load the plugin hook and scripts without installing the package
# ---------------------------------------------------------------------------

PLUGIN_ROOT = Path(__file__).parents[4] / "plugins" / "universe"
SCRIPTS_DIR = PLUGIN_ROOT / "scripts"
HOOKS_DIR = PLUGIN_ROOT / "hooks"


def _load_module(path: Path, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _get_curated():
    """Load scripts/curated.py and return the module."""
    return _load_module(SCRIPTS_DIR / "curated.py", "universe_curated")


def _get_hook():
    """Load hooks/on_activate.py and return the module."""
    return _load_module(HOOKS_DIR / "on_activate.py", "universe_on_activate")


def _activate(markets: list[str] | None = None, extra_config: dict | None = None) -> dict:
    hook = _get_hook()
    config: dict = {}
    if markets is not None:
        config["markets"] = markets
    if extra_config:
        config.update(extra_config)
    return hook.on_activate({"config": config})


# ---------------------------------------------------------------------------
# (a) markets=["nasdaq100"] returns the nasdaq100 list
# ---------------------------------------------------------------------------


def test_nasdaq100_market_returns_correct_symbols():
    result = _activate(["nasdaq100"])
    assert result["ok"] is True
    universe = result["universe"]
    # Must contain well-known Nasdaq-100 tickers
    for ticker in ("AAPL", "MSFT", "NVDA", "AMZN", "META"):
        assert ticker in universe, f"{ticker} missing from nasdaq100 universe"
    # Must NOT contain crypto or forex symbols
    assert not any("/" in s for s in universe), "Forex pairs leaked into nasdaq100 market"


# ---------------------------------------------------------------------------
# (b) markets=["crypto-defi","forex-majors"] returns the union of both
# ---------------------------------------------------------------------------


def test_union_of_crypto_defi_and_forex_majors():
    result_combined = _activate(["crypto-defi", "forex-majors"])
    result_defi = _activate(["crypto-defi"])
    result_forex = _activate(["forex-majors"])

    assert result_combined["ok"] is True
    combined = set(result_combined["universe"])
    defi_only = set(result_defi["universe"])
    forex_only = set(result_forex["universe"])

    # Every symbol from each sub-list must appear in the union
    assert defi_only.issubset(combined), "Some crypto-defi symbols missing from union"
    assert forex_only.issubset(combined), "Some forex-majors symbols missing from union"
    # Combined count is the union (no duplicates)
    assert result_combined["count"] == len(combined)


# ---------------------------------------------------------------------------
# (c) nasdaq100 list length/content matches the original source
# ---------------------------------------------------------------------------


def test_nasdaq100_list_matches_original_source():
    curated = _get_curated()
    # The curated module must expose NASDAQ100 verbatim
    result = _activate(["nasdaq100"])
    universe = result["universe"]
    # Length check — original has 100 tickers
    assert len(curated.NASDAQ100) == 100
    # Every ticker in the curated list must be in the returned universe
    for ticker in curated.NASDAQ100:
        assert ticker in universe, f"{ticker} from curated list not in returned universe"


# ---------------------------------------------------------------------------
# (d) unknown market name is ignored safely
# ---------------------------------------------------------------------------


def test_unknown_market_name_ignored_safely():
    result = _activate(["nasdaq100", "nonexistent-market-xyz"])
    # Should still succeed and return the valid market's symbols
    assert result["ok"] is True
    assert len(result["universe"]) > 0
    # Unknown market must not cause a crash or empty result
    assert result["count"] == len(result["universe"])


# ---------------------------------------------------------------------------
# (e) default config returns a non-empty list
# ---------------------------------------------------------------------------


def test_default_config_returns_non_empty_list():
    # No markets specified → default config
    result = _activate()
    assert result["ok"] is True
    assert isinstance(result["universe"], list)
    assert len(result["universe"]) > 0, "Default config returned an empty universe"
    assert result["count"] == len(result["universe"])


# ---------------------------------------------------------------------------
# (f) on_activate discloses the curated universe snapshot date (survivorship
#     bias disclosure) via an additive "as_of" key.
# ---------------------------------------------------------------------------


def test_on_activate_includes_as_of_snapshot_date():
    curated = _get_curated()
    result = _activate(["nasdaq100"])
    assert result["ok"] is True
    assert result["as_of"] == curated.UNIVERSE_SNAPSHOT_DATE
    assert result["as_of"] == "2026-06-30"
