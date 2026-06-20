"""
TDD tests for SDK soft-check helpers and integration in runner commands.

Phase 3, Tasks 3.1 + 3.2 — RED: written before helpers are added to runner.py.

Unit tests (3.1):
- _parse_semver: parses valid semver, returns None for invalid
- _semver_gte: correct comparison, non-parseable min → True (don't block)
- _sdk_version_warning: returns str when installed < min, None otherwise;
  handles ImportError/AttributeError on SDK import

Integration tests (3.2):
- cmd_run_hook: min > installed → warnings key populated; ok still true; plugin runs
- cmd_run_cycle: same pattern
- min <= installed → no warnings
- no min_sdk_version → no warnings

AC-9: min > installed SDK → warning + ok true + plugin executed
AC-10: min <= installed → no warning
AC-11: min absent → no check, no warning
AC-12: non-parseable min_sdk_version → no warning, no raise
AC-13: check NEVER raises, NEVER sets ok:false
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tomllib
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

SANDBOX_DIR = Path(__file__).parent.parent
RUNNER_PATH = SANDBOX_DIR / "runner.py"
SDK_PATH = SANDBOX_DIR.parent.parent / "packages" / "plugin-sdk"


def _load_runner():
    """Load a fresh runner module to get helpers and command functions."""
    if str(SDK_PATH) not in sys.path:
        sys.path.insert(0, str(SDK_PATH))
    spec = importlib.util.spec_from_file_location("_runner_sdk_check", RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ── Unit tests: _parse_semver ─────────────────────────────────────────────────

class TestParseSemver:
    """_parse_semver must parse valid semver tuples and return None for invalid."""

    def test_valid_semver(self):
        """AC-9: _parse_semver('1.2.3') == (1, 2, 3)."""
        mod = _load_runner()
        assert mod._parse_semver("1.2.3") == (1, 2, 3)

    def test_valid_semver_zero(self):
        assert _load_runner()._parse_semver("0.1.0") == (0, 1, 0)

    def test_valid_semver_large(self):
        assert _load_runner()._parse_semver("10.20.30") == (10, 20, 30)

    def test_invalid_semver_returns_none(self):
        """AC-12: non-parseable version returns None."""
        mod = _load_runner()
        assert mod._parse_semver("bad") is None

    def test_invalid_partial_returns_none(self):
        assert _load_runner()._parse_semver("1.2") is None

    def test_invalid_empty_returns_none(self):
        assert _load_runner()._parse_semver("") is None

    def test_invalid_with_prerelease_returns_none(self):
        # Strict regex only matches X.Y.Z — no pre-release suffix
        assert _load_runner()._parse_semver("1.2.3-beta") is None


# ── Unit tests: _semver_gte ───────────────────────────────────────────────────

class TestSemverGte:
    """_semver_gte must return True when installed >= required."""

    def test_equal_versions(self):
        """AC-10: equal installed == required → True."""
        mod = _load_runner()
        assert mod._semver_gte("0.1.0", "0.1.0") is True

    def test_installed_greater(self):
        """AC-10: installed > required → True (no warning)."""
        mod = _load_runner()
        assert mod._semver_gte("0.2.0", "0.1.0") is True

    def test_installed_less(self):
        """AC-9: installed < required → False."""
        mod = _load_runner()
        assert mod._semver_gte("0.1.0", "0.2.0") is False

    def test_major_version_ordering(self):
        mod = _load_runner()
        assert mod._semver_gte("1.0.0", "0.9.9") is True
        assert mod._semver_gte("0.9.9", "1.0.0") is False

    def test_non_parseable_required_returns_true(self):
        """AC-12: non-parseable required → don't block → return True."""
        mod = _load_runner()
        assert mod._semver_gte("0.1.0", "bad") is True

    def test_non_parseable_installed_returns_true(self):
        """AC-12: non-parseable installed → don't block → return True."""
        mod = _load_runner()
        assert mod._semver_gte("bad", "0.1.0") is True


# ── Unit tests: _sdk_version_warning ─────────────────────────────────────────

class TestSdkVersionWarning:
    """_sdk_version_warning returns str warning or None; never raises."""

    def test_min_greater_than_installed_returns_warning(self):
        """AC-9: min_sdk_version > installed → returns non-None warning string."""
        mod = _load_runner()
        manifest = {"plugin": {"min_sdk_version": "0.2.0"}}
        # SDK installed version is 0.1.0 (set in __init__.py)
        result = mod._sdk_version_warning(manifest)
        assert result is not None, "Expected a warning string; got None"
        assert isinstance(result, str)
        assert "0.2.0" in result, f"Warning should mention required version; got: {result}"
        assert "0.1.0" in result, f"Warning should mention installed version; got: {result}"

    def test_min_equal_to_installed_returns_none(self):
        """AC-10: min_sdk_version == installed → None (no warning)."""
        mod = _load_runner()
        manifest = {"plugin": {"min_sdk_version": "0.1.0"}}
        assert mod._sdk_version_warning(manifest) is None

    def test_min_less_than_installed_returns_none(self):
        """AC-10: min_sdk_version < installed → None (no warning)."""
        mod = _load_runner()
        manifest = {"plugin": {"min_sdk_version": "0.0.9"}}
        assert mod._sdk_version_warning(manifest) is None

    def test_no_min_sdk_version_returns_none(self):
        """AC-11: no min_sdk_version field → None."""
        mod = _load_runner()
        assert mod._sdk_version_warning({"plugin": {}}) is None
        assert mod._sdk_version_warning({}) is None

    def test_sdk_import_error_returns_none(self):
        """AC-12: ImportError when importing neurotrader_sdk → None, no raise."""
        mod = _load_runner()
        manifest = {"plugin": {"min_sdk_version": "0.2.0"}}
        with patch.dict("sys.modules", {"neurotrader_sdk": None}):
            result = mod._sdk_version_warning(manifest)
        assert result is None

    def test_non_parseable_min_returns_none(self):
        """AC-12: non-parseable min_sdk_version → no warning (don't block)."""
        mod = _load_runner()
        manifest = {"plugin": {"min_sdk_version": "not-a-version"}}
        result = mod._sdk_version_warning(manifest)
        assert result is None

    def test_never_raises(self):
        """AC-13: _sdk_version_warning must never raise under any input."""
        mod = _load_runner()
        bad_manifests = [
            None,
            {},
            {"plugin": None},
            {"plugin": {"min_sdk_version": "bad"}},
            {"plugin": {"min_sdk_version": ""}},
        ]
        for m in bad_manifests:
            try:
                mod._sdk_version_warning(m)
            except Exception as e:
                pytest.fail(f"_sdk_version_warning raised {type(e).__name__}: {e!r} for manifest={m!r}")


# ── Integration tests: cmd_run_hook + cmd_run_cycle ──────────────────────────

def _make_test_plugin(plugins_dir: Path, min_sdk_version: str | None = None) -> str:
    """Create a minimal hook plugin for integration testing."""
    plugin_id = "sdk-check-test-plugin"
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    # manifest.toml
    min_sdk_line = f'\nmin_sdk_version = "{min_sdk_version}"' if min_sdk_version else ""
    (plugin_dir / "manifest.toml").write_text(
        f'[plugin]\nid = "{plugin_id}"\nname = "SDK Check Test"\n'
        f'version = "1.0.0"\ntype = "skill"{min_sdk_line}\n\n'
        f'[skills]\nkeys = ["{plugin_id}.do_thing"]\n'
    )

    # hooks/on_cycle.py
    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir(exist_ok=True)
    (hooks_dir / "on_cycle.py").write_text(
        'def on_cycle(ctx):\n    return {"signals": [{"executed": True}], "logs": []}\n'
    )

    # plugin.py
    (plugin_dir / "plugin.py").write_text(
        "def do_thing(**kwargs): return 'ok'\n"
    )

    return plugin_id


class TestSdkSoftCheckIntegration:
    """Integration tests: soft check integrates into cmd_run_hook and cmd_run_cycle."""

    def test_run_hook_warns_when_min_greater_than_installed(self, plugins_dir, monkeypatch):
        """AC-9: cmd_run_hook with min_sdk_version > installed → warnings non-empty; ok True; hook ran."""
        if str(SDK_PATH) not in sys.path:
            sys.path.insert(0, str(SDK_PATH))
        mod = _load_runner()

        plugin_id = _make_test_plugin(plugins_dir, min_sdk_version="0.2.0")
        monkeypatch.setattr(mod, "PLUGINS_DIR", plugins_dir)

        req = {
            "cmd": "run_hook",
            "plugin_id": plugin_id,
            "hook": "on_cycle",
            "context": {},
        }
        result = mod.cmd_run_hook(req)

        assert "warnings" in result, f"Expected 'warnings' key in result; got keys: {list(result)}"
        assert len(result["warnings"]) > 0, f"Expected non-empty warnings; got: {result['warnings']}"
        # ok stays true — we verify by checking result is a dict with signals (not an error)
        assert "signals" in result or "logs" in result, (
            f"Plugin hook must have executed; result: {result}"
        )

    def test_run_hook_no_warning_when_min_satisfied(self, plugins_dir, monkeypatch):
        """AC-10: min_sdk_version <= installed → no warnings."""
        if str(SDK_PATH) not in sys.path:
            sys.path.insert(0, str(SDK_PATH))
        mod = _load_runner()

        plugin_id = _make_test_plugin(plugins_dir, min_sdk_version="0.1.0")
        monkeypatch.setattr(mod, "PLUGINS_DIR", plugins_dir)

        req = {"cmd": "run_hook", "plugin_id": plugin_id, "hook": "on_cycle", "context": {}}
        result = mod.cmd_run_hook(req)

        warnings = result.get("warnings", [])
        assert len(warnings) == 0, f"Expected no warnings; got: {warnings}"

    def test_run_hook_no_warning_when_no_min_sdk_version(self, plugins_dir, monkeypatch):
        """AC-11: no min_sdk_version → no warnings."""
        if str(SDK_PATH) not in sys.path:
            sys.path.insert(0, str(SDK_PATH))
        mod = _load_runner()

        plugin_id = _make_test_plugin(plugins_dir, min_sdk_version=None)
        monkeypatch.setattr(mod, "PLUGINS_DIR", plugins_dir)

        req = {"cmd": "run_hook", "plugin_id": plugin_id, "hook": "on_cycle", "context": {}}
        result = mod.cmd_run_hook(req)

        warnings = result.get("warnings", [])
        assert len(warnings) == 0, f"Expected no warnings when no min_sdk_version; got: {warnings}"

    def test_run_cycle_warns_when_min_greater_than_installed(self, plugins_dir, monkeypatch):
        """AC-9: cmd_run_cycle result has warnings when min_sdk_version > installed."""
        if str(SDK_PATH) not in sys.path:
            sys.path.insert(0, str(SDK_PATH))
        mod = _load_runner()

        # For run_cycle we need a universe_provider or discipline plugin.
        # Use a discipline plugin so the cycle actually executes it.
        plugin_id = "cycle-sdk-check-plugin"
        plugin_dir = plugins_dir / plugin_id
        plugin_dir.mkdir(parents=True, exist_ok=True)
        (plugin_dir / "manifest.toml").write_text(
            f'[plugin]\nid = "{plugin_id}"\nname = "Cycle SDK Check"\n'
            f'version = "1.0.0"\ntype = "discipline"\n'
            f'min_sdk_version = "0.2.0"\n\n'
            f'[discipline]\nfunction = "run_discipline"\n'
        )
        (plugin_dir / "plugin.py").write_text(
            'def run_discipline(universe, _context): return []\n'
        )

        monkeypatch.setattr(mod, "PLUGINS_DIR", plugins_dir)

        req = {
            "cmd": "run_cycle",
            "active_ids": [plugin_id],
            "context": {},
        }
        result = mod.cmd_run_cycle(req)

        assert "warnings" in result, (
            f"Expected 'warnings' key in run_cycle result; got keys: {list(result)}"
        )
        assert len(result["warnings"]) > 0, (
            f"Expected non-empty warnings in run_cycle; got: {result['warnings']}"
        )

    def test_ok_never_false_due_to_sdk_version(self, plugins_dir, monkeypatch):
        """AC-13: soft-check never sets ok:false. Verified by main() wrapper."""
        if str(SDK_PATH) not in sys.path:
            sys.path.insert(0, str(SDK_PATH))
        mod = _load_runner()

        plugin_id = _make_test_plugin(plugins_dir, min_sdk_version="9.9.9")
        monkeypatch.setattr(mod, "PLUGINS_DIR", plugins_dir)

        req = {"cmd": "run_hook", "plugin_id": plugin_id, "hook": "on_cycle", "context": {}}
        # If cmd_run_hook returns without raising, the main() wrapper will produce ok:true
        result = mod.cmd_run_hook(req)

        # Must have warnings but plugin must have executed (not raised)
        assert "warnings" in result and len(result["warnings"]) > 0
        # The hook executed — signals or logs should be present
        assert "signals" in result or "logs" in result
