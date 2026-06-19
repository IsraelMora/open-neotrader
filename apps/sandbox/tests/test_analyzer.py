"""
TDD tests for apps/sandbox/analyzer.py — Static AST Analysis (F3-s1 PR1).

Phase 1 (RED): all tests written before analyzer.py exists.
Phase 2 (GREEN): analyzer.py implemented to pass all tests.

CRITICAL: analyzer MUST NEVER import or execute plugin code — AST parse only.
The test_no_code_execution test enforces this with a sentinel side-effect fixture.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helper: import analyzer fresh so isolation guards don't interfere.
# analyzer.py lives in the same directory as runner.py (apps/sandbox/).
# pyproject.toml sets pythonpath = ["."] so `import analyzer` works from tests.
# ---------------------------------------------------------------------------

SANDBOX_DIR = Path(__file__).parent.parent


def _import_analyzer():
    """Import the analyzer module. Raises ImportError if not yet created (RED phase)."""
    import importlib
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "analyzer_under_test", SANDBOX_DIR / "analyzer.py"
    )
    if spec is None:
        raise ImportError("analyzer.py not found")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# ---------------------------------------------------------------------------
# Phase 1, Task 1.1 — conftest factory is shared; the fixture below is LOCAL
# to analyzer tests and uses the make_plugin_dir factory from conftest.
# (conftest.py provides `make_plugin_dir`; tests use it directly.)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Phase 1, Task 1.2 — risky_import
# ---------------------------------------------------------------------------


class TestRiskyImport:
    """Plugin that imports subprocess must yield a risky_import warning."""

    def test_risky_import_subprocess(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="import subprocess\n\ndef my_fn(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-risky", "name": "Test", "version": "0.1.0", "type": "skill"},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "risky_import" in categories, f"Expected risky_import finding, got: {result['findings']}"

        risky = [f for f in result["findings"] if f["category"] == "risky_import"]
        assert len(risky) >= 1
        assert risky[0]["severity"] in ("warn", "warning")
        assert "file" in risky[0]
        assert "line" in risky[0]

    def test_risky_import_multiprocessing(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="import multiprocessing\n\ndef my_fn(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-risky2", "name": "Test2", "version": "0.1.0", "type": "skill"},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "risky_import" in categories, f"Expected risky_import for multiprocessing, got: {categories}"


# ---------------------------------------------------------------------------
# Phase 1, Task 1.3 — dangerous_call
# ---------------------------------------------------------------------------


class TestDangerousCall:
    """Plugin that calls eval() must yield a dangerous_call warning."""

    def test_dangerous_call_eval(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src='x = eval("1+1")\n',
            manifest_dict={
                "plugin": {"id": "test-eval", "name": "Eval", "version": "0.1.0", "type": "skill"},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "dangerous_call" in categories, f"Expected dangerous_call finding, got: {result['findings']}"

        dangerous = [f for f in result["findings"] if f["category"] == "dangerous_call"]
        assert dangerous[0]["severity"] in ("warn", "warning")

    def test_dangerous_call_exec(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src='exec("x=1")\n',
            manifest_dict={
                "plugin": {"id": "test-exec", "name": "Exec", "version": "0.1.0", "type": "skill"},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        assert any(f["category"] == "dangerous_call" for f in result["findings"]), (
            f"Expected dangerous_call for exec(), got: {result['findings']}"
        )


# ---------------------------------------------------------------------------
# Phase 1, Task 1.4 — network_mismatch
# ---------------------------------------------------------------------------


class TestNetworkMismatch:
    """permissions.network=false + import requests → network_mismatch warning."""

    def test_network_mismatch_requests(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="import requests\n\ndef fetch(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-net", "name": "Net", "version": "0.1.0", "type": "skill"},
                "permissions": {"network": False},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "network_mismatch" in categories, (
            f"Expected network_mismatch finding, got: {result['findings']}"
        )
        mismatch = [f for f in result["findings"] if f["category"] == "network_mismatch"]
        assert mismatch[0]["severity"] in ("warn", "warning")

    def test_no_network_mismatch_when_permitted(self, make_plugin_dir):
        """When permissions.network=true, network imports should NOT trigger network_mismatch."""
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="import requests\n\ndef fetch(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-net-ok", "name": "NetOk", "version": "0.1.0", "type": "skill"},
                "permissions": {"network": True},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "network_mismatch" not in categories, (
            f"Should not flag network_mismatch when network=true, got: {result['findings']}"
        )


# ---------------------------------------------------------------------------
# Phase 1, Task 1.5 — missing_hook
# ---------------------------------------------------------------------------


class TestMissingHook:
    """Manifest declares a hook file that does not exist on disk → missing_hook warning."""

    def test_missing_hook_file(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="def my_fn(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-hook", "name": "Hook", "version": "0.1.0", "type": "skill"},
                "hooks": {"on_activate": "hooks/on_activate.py"},
            },
            # hooks={} means no actual hook files written to disk
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "missing_hook" in categories, (
            f"Expected missing_hook finding when hook file absent, got: {result['findings']}"
        )
        hook_finding = [f for f in result["findings"] if f["category"] == "missing_hook"]
        assert hook_finding[0]["severity"] in ("warn", "warning")

    def test_no_missing_hook_when_file_present(self, make_plugin_dir):
        """Declared hook file that actually exists on disk must NOT yield missing_hook."""
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="def my_fn(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-hook-ok", "name": "HookOk", "version": "0.1.0", "type": "skill"},
                "hooks": {"on_activate": "hooks/on_activate.py"},
            },
            hooks={"on_activate": "def on_activate(ctx): pass\n"},
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "missing_hook" not in categories, (
            f"Should not flag missing_hook when file exists, got: {result['findings']}"
        )


# ---------------------------------------------------------------------------
# Phase 1, Task 1.6 — undefined_skill
# ---------------------------------------------------------------------------


class TestUndefinedSkill:
    """manifest skills.keys lists a function name absent from plugin.py → undefined_skill."""

    def test_undefined_skill_function(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            # plugin.py has other_fn but NOT my_signal
            plugin_py_src="def other_fn(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-skill", "name": "Skill", "version": "0.1.0", "type": "skill"},
                "skills": {"keys": ["test-skill.my_signal"]},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "undefined_skill" in categories, (
            f"Expected undefined_skill finding, got: {result['findings']}"
        )
        skill_finding = [f for f in result["findings"] if f["category"] == "undefined_skill"]
        assert skill_finding[0]["severity"] in ("warn", "warning")

    def test_no_undefined_skill_when_defined(self, make_plugin_dir):
        """Skill key whose function IS defined in plugin.py must NOT yield undefined_skill."""
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="def my_signal(): pass\n",
            manifest_dict={
                "plugin": {"id": "test-skill-ok", "name": "SkillOk", "version": "0.1.0", "type": "skill"},
                "skills": {"keys": ["test-skill-ok.my_signal"]},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        categories = [f["category"] for f in result["findings"]]
        assert "undefined_skill" not in categories, (
            f"Should not flag undefined_skill when function exists, got: {result['findings']}"
        )


# ---------------------------------------------------------------------------
# Phase 1, Task 1.7 — parse_error (no crash, ok=True)
# ---------------------------------------------------------------------------


class TestParseError:
    """Syntactically invalid plugin.py → parse_error finding, ok still True, no exception."""

    def test_parse_error_non_crash(self, make_plugin_dir):
        # Broken Python — unclosed def
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="def foo(\n",
            manifest_dict={
                "plugin": {"id": "test-parse", "name": "Parse", "version": "0.1.0", "type": "skill"},
            },
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        # ok must remain True even on parse error
        assert result["ok"] is True, f"ok must be True on parse error, got: {result}"
        categories = [f["category"] for f in result["findings"]]
        assert "parse_error" in categories, (
            f"Expected parse_error finding for invalid Python, got: {result['findings']}"
        )

    def test_parse_error_with_valid_second_file(self, make_plugin_dir, tmp_path):
        """
        If plugin.py is broken but a hook file is valid, the analyzer must:
        - record parse_error for the broken file
        - still analyze the valid hook file
        - ok stays True throughout
        """
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="def broken(\n",  # SyntaxError
            manifest_dict={
                "plugin": {"id": "test-parse2", "name": "Parse2", "version": "0.1.0", "type": "skill"},
                "hooks": {"on_activate": "hooks/on_activate.py"},
            },
            hooks={"on_activate": "def on_activate(ctx): pass\n"},
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        assert any(f["category"] == "parse_error" for f in result["findings"]), (
            f"Expected parse_error finding. Got: {result['findings']}"
        )


# ---------------------------------------------------------------------------
# Phase 1, Task 1.8 — no_code_execution (sentinel test — THE most critical)
# ---------------------------------------------------------------------------


class TestNoCodeExecution:
    """
    The analyzer MUST NEVER import or execute plugin code.

    Proof: plugin.py writes a sentinel file at module-level. If the analyzer
    ever imports/executes it, the sentinel appears. It must NOT appear after
    analyze_plugin() returns.
    """

    def test_no_code_execution(self, make_plugin_dir, tmp_path):
        sentinel = tmp_path / "sideeffect_sentinel.txt"
        # plugin.py writes to sentinel at module level — fires on ANY import/exec
        side_effect_src = f'open("{sentinel}", "w").write("executed")\n\ndef my_fn(): pass\n'

        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src=side_effect_src,
            manifest_dict={
                "plugin": {"id": "test-noexec", "name": "NoExec", "version": "0.1.0", "type": "skill"},
            },
        )
        analyzer = _import_analyzer()

        # Sentinel must not exist before
        assert not sentinel.exists(), "Sentinel file existed before test ran"

        result = analyzer.analyze_plugin(plugin_dir, manifest)

        # analyze_plugin must complete without executing the plugin
        assert not sentinel.exists(), (
            "SENTINEL FILE WAS CREATED — analyzer executed plugin code! "
            "analyzer.py MUST use ast.parse only, never importlib/exec_module."
        )
        # And the result must still be valid (AST scan succeeded or parse_error)
        assert "ok" in result


# ---------------------------------------------------------------------------
# Phase 1, Task 1.9 — clean_plugin
# ---------------------------------------------------------------------------


class TestCleanPlugin:
    """A harmless plugin with no risky patterns must produce zero findings."""

    def test_clean_plugin_no_findings(self, make_plugin_dir):
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src=(
                "def compute(signal, _context=None):\n"
                "    return signal['price'] * 1.05\n"
            ),
            manifest_dict={
                "plugin": {"id": "test-clean", "name": "Clean", "version": "0.1.0", "type": "skill"},
                "skills": {"keys": ["test-clean.compute"]},
                "permissions": {"network": False},
            },
            hooks={},
        )
        analyzer = _import_analyzer()
        result = analyzer.analyze_plugin(plugin_dir, manifest)

        assert result["ok"] is True
        assert result["findings"] == [], (
            f"Expected empty findings for clean plugin, got: {result['findings']}"
        )
        assert result["summary"]["warn_count"] == 0, (
            f"Expected warn_count=0, got: {result['summary']}"
        )
        assert result["summary"]["info_count"] == 0, (
            f"Expected info_count=0, got: {result['summary']}"
        )
