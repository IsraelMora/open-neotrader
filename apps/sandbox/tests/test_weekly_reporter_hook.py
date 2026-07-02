"""
Tests for the weekly-reporter plugin's on_cycle hook.
RED phase: these tests will fail until hooks/cycle.py is renamed to hooks/on_cycle.py
and def run is renamed to def on_cycle.
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).parents[3] / "plugins" / "weekly-reporter"


def _load_on_cycle():
    """Load the on_cycle function from plugins/weekly-reporter/hooks/on_cycle.py."""
    # Undo sandbox isolation poisoning (test_isolation.py sets urllib.request → None
    # in sys.modules; our hook imports it at module level, so we must clear it here)
    for blocked_mod in list(sys.modules.keys()):
        if sys.modules[blocked_mod] is None and (
            blocked_mod.startswith("urllib") or blocked_mod in ("socket", "ssl", "http")
        ):
            del sys.modules[blocked_mod]

    hook_path = PLUGIN_DIR / "hooks" / "on_cycle.py"
    spec = importlib.util.spec_from_file_location("weekly_reporter_on_cycle", hook_path)
    assert spec is not None and spec.loader is not None, (
        f"Cannot load {hook_path} — file may not exist yet"
    )
    mod = importlib.util.module_from_spec(spec)
    plugin_str = str(PLUGIN_DIR)
    if plugin_str not in sys.path:
        sys.path.insert(0, plugin_str)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


def test_weekly_reporter_on_cycle_importable():
    """A1.6 — plugins/weekly-reporter/hooks/on_cycle.py must exist and expose on_cycle()."""
    mod = _load_on_cycle()
    assert hasattr(mod, "on_cycle"), (
        "on_cycle function not found in hooks/on_cycle.py — "
        "was 'def run' renamed to 'def on_cycle'?"
    )


def test_weekly_reporter_on_cycle_returns_dict():
    """A1.6 — on_cycle({}) must return a dict (may be empty if not report day)."""
    mod = _load_on_cycle()
    result = mod.on_cycle({})
    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
