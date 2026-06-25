"""Shared fixtures for backtester plugin tests."""
from __future__ import annotations

import sys
import importlib
import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).parents[4]
_PLUGIN_DIR = _REPO_ROOT / "plugins" / "backtester"
_SCRIPTS_DIR = _PLUGIN_DIR / "scripts"


def load_generate():
    """Load generate.py as a fresh module from the scripts directory."""
    spec = importlib.util.spec_from_file_location(
        "backtester_generate",
        str(_SCRIPTS_DIR / "generate.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def load_cross_sectional():
    """Load cross_sectional.py as a fresh module from the scripts directory."""
    spec = importlib.util.spec_from_file_location(
        "backtester_cross_sectional",
        str(_SCRIPTS_DIR / "cross_sectional.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def load_plugin():
    """Load plugin.py with scripts/ on sys.path so it can import generate/engine."""
    scripts_str = str(_SCRIPTS_DIR)
    if scripts_str not in sys.path:
        sys.path.insert(0, scripts_str)
    spec = importlib.util.spec_from_file_location(
        "backtester_plugin",
        str(_PLUGIN_DIR / "plugin.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(autouse=True)
def _restore_sys_path():
    original = sys.path[:]
    yield
    sys.path[:] = original
