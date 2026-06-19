"""
Tests for the doctor plugin's on_cycle hook.
RED phase: these tests will fail until hooks/cycle.py is renamed to hooks/on_cycle.py
and def run is renamed to def on_cycle.
"""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path


PLUGIN_DIR = Path(__file__).parents[3] / "plugins" / "doctor"


def _load_on_cycle():
    """Load the on_cycle function from plugins/doctor/hooks/on_cycle.py."""
    hook_path = PLUGIN_DIR / "hooks" / "on_cycle.py"
    spec = importlib.util.spec_from_file_location("doctor_on_cycle", hook_path)
    assert spec is not None and spec.loader is not None, (
        f"Cannot load {hook_path} — file may not exist yet"
    )
    mod = importlib.util.module_from_spec(spec)
    plugin_str = str(PLUGIN_DIR)
    if plugin_str not in sys.path:
        sys.path.insert(0, plugin_str)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


def test_doctor_on_cycle_importable():
    """A1.5 — plugins/doctor/hooks/on_cycle.py must exist and expose on_cycle()."""
    mod = _load_on_cycle()
    assert hasattr(mod, "on_cycle"), (
        "on_cycle function not found in hooks/on_cycle.py — was 'def run' renamed to 'def on_cycle'?"
    )


def test_doctor_on_cycle_returns_nonempty_dict():
    """A1.5 — on_cycle({}) must return a non-empty dict."""
    mod = _load_on_cycle()
    result = mod.on_cycle({})
    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    assert len(result) > 0, "on_cycle returned an empty dict — expected at least one key"


def test_doctor_on_cycle_returns_expected_keys():
    """on_cycle context must contain doctor_report or cycle_abort or log."""
    mod = _load_on_cycle()
    result = mod.on_cycle({})
    known_keys = {"doctor_report", "cycle_abort", "log"}
    assert known_keys.intersection(result.keys()), (
        f"Result lacks expected keys (doctor_report/cycle_abort/log). Got: {list(result.keys())}"
    )
