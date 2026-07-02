"""
TDD tests for the silent-dead-plugin-hook bug.

Bug: apps/sandbox/runner.py dispatches cycle hooks by looking up on_cycle(ctx)
ONLY. Several plugins defined their entrypoint as run(ctx) instead, so
_load_cycle_hook() found the module but getattr(mod, "on_cycle", None) came
back None, and cmd_run_cycle silently `continue`d — no error, no warning.

RED phase (before fix):
  (a) fails because plugins/ensemble-signal-voting/hooks/cycle.py still
      defines run(ctx), not on_cycle(ctx) — the signal never reaches
      pending_signals.
  (b) fails because runner.py has no guardrail: a hook file that exists but
      has no on_cycle() is skipped in total silence (no stderr output).
  (c) fails for the same reason as (a): plugins/param-discipline/hooks/cycle.py
      defines run(ctx) and returns the raw ctx instead of the
      {"signals": [...], "logs": [...]} contract used by the real dispatch
      path (_runVetoLayer → cmd_run_hook with hook="on_cycle").

GREEN phase (after fix): all three pass.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SANDBOX_DIR = Path(__file__).parent.parent
RUNNER_PATH = SANDBOX_DIR / "runner.py"
SDK_PATH = SANDBOX_DIR.parent.parent / "packages" / "plugin-sdk"
REAL_PLUGINS_DIR = SANDBOX_DIR.parent.parent / "plugins"


def _load_runner():
    """Load a fresh runner module, patching away rlimit and isolation side-effects."""
    if str(SDK_PATH) not in sys.path:
        sys.path.insert(0, str(SDK_PATH))
    spec = importlib.util.spec_from_file_location("_runner_dead_hooks_test", RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)

    try:
        import resource as _res
        original_setrlimit = _res.setrlimit
        _res.setrlimit = lambda *a, **kw: None
    except ImportError:
        original_setrlimit = None
        _res = None  # type: ignore[assignment]

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


# ---------------------------------------------------------------------------
# (a) A real skill plugin's on_cycle hook must be dispatched via run_cycle
#     and its signals must propagate into pending_signals/signals.
# ---------------------------------------------------------------------------


class TestRealSkillPluginOnCycleDispatch:
    @pytest.fixture(autouse=True)
    def _point_to_real_plugins(self, monkeypatch):
        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", REAL_PLUGINS_DIR)
        self.mod = mod

    def test_ensemble_signal_voting_on_cycle_produces_signals(self):
        """
        ensemble-signal-voting (type=skill) must expose on_cycle(ctx) and its
        buy/sell decisions must show up in cmd_run_cycle's "signals" output.

        Uses a simple monotonic uptrend so the ensemble's EMA/Donchian/TSMOM
        voters agree on "buy" for at least min_votes-worth of variants.
        """
        prices = [100.0 + i * 1.5 for i in range(260)]
        req = {
            "cmd": "run_cycle",
            "active_ids": ["ensemble-signal-voting"],
            "context": {"price_data": {"AAA": prices}},
        }
        result = self.mod.cmd_run_cycle(req)

        assert result["errors"] == [], f"Unexpected errors: {result['errors']}"
        assert len(result["signals"]) > 0, (
            "Expected at least one signal from ensemble-signal-voting's on_cycle hook — "
            "got none. Is the hook still defining run(ctx) instead of on_cycle(ctx)?"
        )
        assert all(s.get("_plugin") == "ensemble-signal-voting" for s in result["signals"])


# ---------------------------------------------------------------------------
# (b) Guardrail: a hook file that exists but has no on_cycle() must emit a
#     clear WARNING identifying the plugin, to stderr only — never stdout.
# ---------------------------------------------------------------------------


class TestDeadHookGuardrail:
    @pytest.fixture()
    def broken_skill_plugin(self, plugins_dir):
        """A synthetic type=skill plugin whose hooks/cycle.py defines run(), not on_cycle()."""
        plugin_id = "broken-skill-plugin"
        plugin_dir = plugins_dir / plugin_id
        (plugin_dir / "hooks").mkdir(parents=True)
        (plugin_dir / "manifest.toml").write_text(
            f"""\
[plugin]
id = "{plugin_id}"
name = "Broken Skill Plugin"
version = "0.1.0"
type = "skill"
"""
        )
        (plugin_dir / "hooks" / "cycle.py").write_text(
            "def run(ctx):\n"
            "    return {'signals': [{'symbol': 'AAA', 'action': 'buy'}], 'logs': []}\n"
        )
        return plugin_id

    def test_missing_on_cycle_logs_warning_to_stderr_naming_plugin(
        self, broken_skill_plugin, capsys
    ):
        mod = _load_runner()
        req = {"cmd": "run_cycle", "active_ids": [broken_skill_plugin], "context": {}}

        result = mod.cmd_run_cycle(req)

        captured = capsys.readouterr()
        assert captured.out == "", (
            "Warning leaked onto stdout — stdout must stay pure JSON protocol channel"
        )
        assert broken_skill_plugin in captured.err, (
            f"Expected a stderr warning naming '{broken_skill_plugin}'. "
            f"Got stderr: {captured.err!r}"
        )
        assert "on_cycle" in captured.err.lower()
        # The broken hook must be skipped safely — no crash, no phantom signals.
        assert result["signals"] == []
        assert result["errors"] == []


# ---------------------------------------------------------------------------
# Per-plugin isolation: a hook file that raises at IMPORT time (not just at
# call time) must not crash the whole cmd_run_cycle for every other plugin.
# ---------------------------------------------------------------------------


class TestImportTimeIsolation:
    @pytest.fixture()
    def import_crashing_plugin(self, plugins_dir):
        plugin_id = "bad-import-plugin"
        plugin_dir = plugins_dir / plugin_id
        (plugin_dir / "hooks").mkdir(parents=True)
        (plugin_dir / "manifest.toml").write_text(
            f"""\
[plugin]
id = "{plugin_id}"
name = "Bad Import Plugin"
version = "0.1.0"
type = "skill"
"""
        )
        # Raises at module-exec time, BEFORE on_cycle is ever looked up or called.
        (plugin_dir / "hooks" / "cycle.py").write_text("raise ImportError('boom at import time')\n")
        return plugin_id

    @pytest.fixture()
    def healthy_plugin(self, plugins_dir):
        plugin_id = "healthy-skill-plugin"
        plugin_dir = plugins_dir / plugin_id
        (plugin_dir / "hooks").mkdir(parents=True)
        (plugin_dir / "manifest.toml").write_text(
            f"""\
[plugin]
id = "{plugin_id}"
name = "Healthy Skill Plugin"
version = "0.1.0"
type = "skill"
"""
        )
        (plugin_dir / "hooks" / "cycle.py").write_text(
            "def on_cycle(ctx):\n"
            "    return {'signals': [{'symbol': 'ZZZ', 'action': 'buy'}], 'logs': []}\n"
        )
        return plugin_id

    def test_import_time_crash_is_isolated_as_plugin_error(self, import_crashing_plugin):
        mod = _load_runner()
        req = {"cmd": "run_cycle", "active_ids": [import_crashing_plugin], "context": {}}

        result = mod.cmd_run_cycle(req)  # must NOT raise

        assert any(e.get("plugin") == import_crashing_plugin for e in result["errors"]), (
            f"Expected an isolated error entry for '{import_crashing_plugin}'. "
            f"Got: {result['errors']}"
        )
        assert result["signals"] == []

    def test_import_time_crash_does_not_block_other_active_plugins(
        self, import_crashing_plugin, healthy_plugin
    ):
        mod = _load_runner()
        req = {
            "cmd": "run_cycle",
            "active_ids": [import_crashing_plugin, healthy_plugin],
            "context": {},
        }

        result = mod.cmd_run_cycle(req)  # must NOT raise

        assert any(s.get("symbol") == "ZZZ" for s in result["signals"]), (
            "The healthy plugin's signal must still be produced even though a sibling "
            "plugin crashed at import time."
        )


# ---------------------------------------------------------------------------
# (c) The revived param-discipline hook must return the {"signals", "logs"}
#     contract when invoked through the REAL runner dispatch path used by
#     _runVetoLayer: cmd_run_hook(plugin_id="param-discipline", hook="on_cycle").
# ---------------------------------------------------------------------------


class TestParamDisciplineRevivedContract:
    @pytest.fixture(autouse=True)
    def _point_to_real_plugins(self, monkeypatch):
        mod = _load_runner()
        monkeypatch.setattr(mod, "PLUGINS_DIR", REAL_PLUGINS_DIR)
        self.mod = mod

    def test_param_discipline_on_cycle_returns_signals_logs_contract(self):
        req = {
            "cmd": "run_hook",
            "plugin_id": "param-discipline",
            "hook": "on_cycle",
            "context": {
                "active_plugin_ids": ["trend-following"],
                "param_journal": [],
                "pending_signals": [{"symbol": "AAA", "action": "buy"}],
            },
        }

        result = self.mod.cmd_run_hook(req)

        assert isinstance(result, dict)
        assert "signals" in result, f"Missing 'signals' key. Got: {list(result.keys())}"
        assert "logs" in result, f"Missing 'logs' key. Got: {list(result.keys())}"
        assert isinstance(result["signals"], list)
        assert isinstance(result["logs"], list)
        # param-discipline does not filter trade signals — it only gates config
        # changes — so pending_signals must pass through unchanged.
        assert result["signals"] == [{"symbol": "AAA", "action": "buy"}]

    def test_param_discipline_on_cycle_does_not_crash_with_locked_plugin(self):
        """A plugin with a very recent journal entry must be reported as locked
        via logs, without raising and without inventing new top-level keys."""
        req = {
            "cmd": "run_hook",
            "plugin_id": "param-discipline",
            "hook": "on_cycle",
            "context": {
                "active_plugin_ids": ["trend-following"],
                "param_journal": [
                    {
                        "plugin_id": "trend-following",
                        "id": "abc123",
                        "ts": "2026-06-30T00:00:00Z",
                        "cycles_since": 0,
                        "hypothesis": "test",
                    }
                ],
                "pending_signals": [],
            },
        }

        result = self.mod.cmd_run_hook(req)

        assert result["signals"] == []
        assert isinstance(result["logs"], list)
        assert set(result.keys()) <= {"signals", "logs", "warnings"}
