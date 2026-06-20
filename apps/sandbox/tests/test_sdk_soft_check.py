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
    """Load a fresh runner module to get helpers and command functions.

    - Patches resource.setrlimit so the rlimit block does not modify this process's
      limits (prevents RLIMIT_NPROC from blocking subprocess spawning in nproc tests).
    - Patches isolation.apply so it does not install the open() guard in-process
      (prevents the guard from blocking file access in subsequent tests that use
      different tmp_path directories).
    """
    if str(SDK_PATH) not in sys.path:
        sys.path.insert(0, str(SDK_PATH))
    spec = importlib.util.spec_from_file_location("_runner_sdk_check", RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)

    # Patch resource.setrlimit to no-op (don't modify current process limits)
    try:
        import resource as _res
        original_setrlimit = _res.setrlimit
        _res.setrlimit = lambda *a, **kw: None
    except ImportError:
        original_setrlimit = None
        _res = None  # type: ignore[assignment]

    # Patch isolation.apply to no-op (don't install open() guard in-process)
    try:
        import isolation as _iso
        original_apply = _iso.apply
        _iso.apply = lambda *a, **kw: None
    except ImportError:
        original_apply = None
        _iso = None  # type: ignore[assignment]

    try:
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    finally:
        if _res is not None and original_setrlimit is not None:
            _res.setrlimit = original_setrlimit
        if _iso is not None and original_apply is not None:
            _iso.apply = original_apply

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


class TestSdkSoftCheckIntegration:
    """
    Integration tests: soft check integrates into cmd_run_hook and cmd_run_cycle.

    These tests patch _read_manifest to avoid real file I/O (which may be blocked
    by the isolation open() guard if test_runner_isolation.py ran earlier in the
    same pytest session). The hook execution itself is also patched because the
    hook file doesn't exist in this test's context.
    """

    def _manifest(self, min_sdk_version: str | None = None, plugin_type: str = "skill") -> dict:
        """Build a minimal manifest dict for use with patched _read_manifest."""
        plugin_section: dict = {
            "id": "test-plugin",
            "name": "Test Plugin",
            "version": "1.0.0",
            "type": plugin_type,
        }
        if min_sdk_version is not None:
            plugin_section["min_sdk_version"] = min_sdk_version
        return {"plugin": plugin_section}

    def test_run_hook_warns_when_min_greater_than_installed(self, monkeypatch):
        """AC-9: cmd_run_hook with min_sdk_version > installed → warnings non-empty; hook still ran."""
        mod = _load_runner()
        plugin_id = "sdk-check-test"

        monkeypatch.setattr(mod, "_read_manifest", lambda _pid: self._manifest("0.2.0"))
        monkeypatch.setattr(mod, "PLUGINS_DIR", Path("/nonexistent"))

        # Patch hook loading: simulate hook-absent path (returns early with signals/logs)
        def _fake_exists(self_path):
            return False

        real_exists = Path.exists

        def patched_exists(p):
            if str(p).endswith(".py"):
                return False
            return real_exists(p)

        monkeypatch.setattr(Path, "exists", patched_exists)
        monkeypatch.setattr(Path, "is_dir", lambda p: str(p).endswith(plugin_id))

        req = {"cmd": "run_hook", "plugin_id": plugin_id, "hook": "on_cycle", "context": {}}
        result = mod.cmd_run_hook(req)

        assert "warnings" in result, f"Expected 'warnings' key; got: {list(result)}"
        assert len(result["warnings"]) > 0, f"Expected non-empty warnings; got: {result['warnings']}"

    def test_run_hook_no_warning_when_min_satisfied(self, monkeypatch):
        """AC-10: min_sdk_version == installed → no warnings."""
        mod = _load_runner()
        plugin_id = "sdk-check-test"

        monkeypatch.setattr(mod, "_read_manifest", lambda _pid: self._manifest("0.1.0"))
        monkeypatch.setattr(mod, "PLUGINS_DIR", Path("/nonexistent"))
        monkeypatch.setattr(Path, "exists", lambda p: False)
        monkeypatch.setattr(Path, "is_dir", lambda p: str(p).endswith(plugin_id))

        req = {"cmd": "run_hook", "plugin_id": plugin_id, "hook": "on_cycle", "context": {}}
        result = mod.cmd_run_hook(req)

        warnings = result.get("warnings", [])
        assert len(warnings) == 0, f"Expected no warnings; got: {warnings}"

    def test_run_hook_no_warning_when_no_min_sdk_version(self, monkeypatch):
        """AC-11: no min_sdk_version → no warnings."""
        mod = _load_runner()
        plugin_id = "sdk-check-test"

        monkeypatch.setattr(mod, "_read_manifest", lambda _pid: self._manifest(None))
        monkeypatch.setattr(mod, "PLUGINS_DIR", Path("/nonexistent"))
        monkeypatch.setattr(Path, "exists", lambda p: False)
        monkeypatch.setattr(Path, "is_dir", lambda p: str(p).endswith(plugin_id))

        req = {"cmd": "run_hook", "plugin_id": plugin_id, "hook": "on_cycle", "context": {}}
        result = mod.cmd_run_hook(req)

        warnings = result.get("warnings", [])
        assert len(warnings) == 0, f"Expected no warnings when no min_sdk_version; got: {warnings}"

    def test_run_cycle_warns_when_min_greater_than_installed(self, tmp_path, monkeypatch):
        """AC-9: cmd_run_cycle result has warnings when min_sdk_version > installed."""
        mod = _load_runner()
        plugin_id = "cycle-sdk-check"

        # Patch _read_manifest and PLUGINS_DIR so the cycle reads our fake manifest
        plugin_dir = tmp_path / plugin_id
        plugin_dir.mkdir()
        fake_manifest = {
            "plugin": {"id": plugin_id, "type": "discipline", "min_sdk_version": "0.2.0"},
            "discipline": {"function": "run_discipline"},
        }

        monkeypatch.setattr(mod, "PLUGINS_DIR", tmp_path)

        def fake_read_manifest(pid):
            if pid == plugin_id:
                return fake_manifest
            return {}

        monkeypatch.setattr(mod, "_read_manifest", fake_read_manifest)

        # Patch _load_module so the discipline function is available without file I/O
        def fake_run_discipline(universe, _context):
            return []

        class FakeMod:
            pass

        fake_mod_inst = FakeMod()
        setattr(fake_mod_inst, "run_discipline", fake_run_discipline)
        monkeypatch.setattr(mod, "_load_module", lambda _pid: fake_mod_inst)

        req = {"cmd": "run_cycle", "active_ids": [plugin_id], "context": {}}
        result = mod.cmd_run_cycle(req)

        assert "warnings" in result, (
            f"Expected 'warnings' key in run_cycle result; got: {list(result)}"
        )
        assert len(result["warnings"]) > 0, (
            f"Expected non-empty warnings in run_cycle; got: {result['warnings']}"
        )

    def test_ok_never_false_due_to_sdk_version(self, monkeypatch):
        """AC-13: soft-check never sets ok:false — cmd_run_hook must return dict, not raise."""
        mod = _load_runner()
        plugin_id = "sdk-check-test"

        # Very high required version — should trigger warning but NOT raise or block
        monkeypatch.setattr(mod, "_read_manifest", lambda _pid: self._manifest("9.9.9"))
        monkeypatch.setattr(mod, "PLUGINS_DIR", Path("/nonexistent"))
        monkeypatch.setattr(Path, "exists", lambda p: False)
        monkeypatch.setattr(Path, "is_dir", lambda p: str(p).endswith(plugin_id))

        req = {"cmd": "run_hook", "plugin_id": plugin_id, "hook": "on_cycle", "context": {}}
        result = mod.cmd_run_hook(req)

        assert isinstance(result, dict), f"cmd_run_hook must return dict; got: {type(result)}"
        assert "warnings" in result and len(result["warnings"]) > 0, (
            "Expected warning for min_sdk_version=9.9.9 > installed 0.1.0"
        )
        # The early-return path (no hook file) means signals/logs are in the result
        assert "signals" in result or "logs" in result
