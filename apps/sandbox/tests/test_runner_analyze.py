"""
TDD tests for runner.py cmd_analyze_plugin dispatch (F3-s1 PR1 Phase 3).

Phase 3 RED: test_runner_analyze_dispatch fails because analyze_plugin command
             is not yet registered in COMMANDS.
Phase 3 GREEN: cmd_analyze_plugin added to runner.py and registered.

Contract:
  - Runner receives {cmd: "analyze_plugin", plugin_id: "<id>"}
  - Returns {ok: True, result: {ok: True, findings: [...], summary: {...}}}
  - MUST NOT call _load_module — AST analysis only
  - Works under SANDBOX_STRICT=true (only reads files + ast.parse)
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

SANDBOX_DIR = Path(__file__).parent.parent
RUNNER_PATH = SANDBOX_DIR / "runner.py"


def _load_runner(plugins_dir: Path):
    """Load a fresh runner module instance pointed at plugins_dir."""
    os.environ["NEUROTRADER_PLUGINS_DIR"] = str(plugins_dir)
    mod_name = f"runner_analyze_{id(plugins_dir)}"
    spec = importlib.util.spec_from_file_location(mod_name, RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    mod.PLUGINS_DIR = plugins_dir
    return mod


def _make_clean_plugin(plugins_dir: Path, plugin_id: str = "test-analyze-plugin") -> str:
    """Create a minimal valid plugin directory for runner dispatch tests."""
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        f'[plugin]\nid = "{plugin_id}"\nname = "Test"\nversion = "0.1.0"\ntype = "skill"\n\n'
        f'[skills]\nkeys = ["{plugin_id}.my_fn"]\n',
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "def my_fn(**kwargs): return 'ok'\n",
        encoding="utf-8",
    )
    return plugin_id


def _make_risky_plugin(plugins_dir: Path, plugin_id: str = "test-risky-runner") -> str:
    """Create a plugin that imports subprocess — should yield risky_import finding."""
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        f'[plugin]\nid = "{plugin_id}"\nname = "Risky"\nversion = "0.1.0"\ntype = "skill"\n',
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "import subprocess\n\ndef my_fn(**kwargs): return 'ok'\n",
        encoding="utf-8",
    )
    return plugin_id


class TestRunnerAnalyzeDispatch:
    """Runner must dispatch cmd=analyze_plugin and return structured scan_result."""

    def test_runner_analyze_dispatch_clean(self, plugins_dir):
        """
        A clean plugin analyzed via runner dispatch must return ok=True with
        findings key and an empty findings list.

        RED: fails because 'analyze_plugin' is not in COMMANDS.
        GREEN: cmd_analyze_plugin registered in runner.py.
        """
        plugin_id = _make_clean_plugin(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["analyze_plugin"]({"plugin_id": plugin_id})

        assert isinstance(result, dict), f"Expected dict result, got: {type(result)}"
        assert result.get("ok") is True, f"Expected ok=True, got: {result}"
        assert "findings" in result, f"Expected 'findings' key, got: {result.keys()}"
        assert isinstance(result["findings"], list), "findings must be a list"
        assert result["findings"] == [], f"Expected no findings for clean plugin, got: {result['findings']}"

    def test_runner_analyze_dispatch_returns_findings(self, plugins_dir):
        """
        A risky plugin analyzed via runner dispatch must return findings.
        Confirms the runner wires through to analyzer.analyze_plugin properly.
        """
        plugin_id = _make_risky_plugin(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["analyze_plugin"]({"plugin_id": plugin_id})

        assert result.get("ok") is True
        assert "findings" in result
        categories = [f["category"] for f in result["findings"]]
        assert "risky_import" in categories, (
            f"Expected risky_import finding for subprocess import, got: {categories}"
        )

    def test_runner_analyze_dispatch_unknown_plugin(self, plugins_dir):
        """
        Unknown plugin_id must return an error dict (not a crash or exception
        propagating up to the caller).

        Note: runner.py wraps handler exceptions in main() as ok=false; here
        we call the handler directly so we expect FileNotFoundError to be raised.
        Callers via main() will receive ok=false.
        """
        runner = _load_runner(plugins_dir)

        with pytest.raises(FileNotFoundError):
            runner.COMMANDS["analyze_plugin"]({"plugin_id": "nonexistent-plugin"})

    def test_runner_analyze_via_main_json_protocol(self, plugins_dir, monkeypatch):
        """
        Full JSON stdin/stdout protocol test: send {cmd: analyze_plugin, plugin_id}
        via stdin, assert stdout JSON has ok=True and findings key.
        """
        import io

        plugin_id = _make_clean_plugin(plugins_dir, "main-proto-plugin")

        # Reload runner to pick up PLUGINS_DIR env var that plugins_dir fixture set
        runner = _load_runner(plugins_dir)

        request_json = json.dumps({"cmd": "analyze_plugin", "plugin_id": plugin_id})
        output_buf = io.StringIO()

        monkeypatch.setenv("SANDBOX_STRICT", "false")  # avoid installing guards in test

        with __import__("unittest.mock", fromlist=["patch"]).patch(
            "sys.stdin", io.StringIO(request_json)
        ):
            with __import__("unittest.mock", fromlist=["patch"]).patch(
                "sys.stdout", output_buf
            ):
                try:
                    runner.main()
                except SystemExit:
                    pass

        output = output_buf.getvalue().strip()
        assert output, "Runner produced no stdout output"

        resp = json.loads(output)
        assert resp.get("ok") is True, f"Expected ok=True in response, got: {resp}"
        inner = resp.get("result", {})
        assert "findings" in inner, f"Expected findings in result, got: {inner}"

    def test_runner_analyze_does_not_call_load_module(self, plugins_dir):
        """
        cmd_analyze_plugin MUST NOT call _load_module.
        Verified by patching _load_module to raise if called.
        """
        from unittest.mock import patch

        plugin_id = _make_clean_plugin(plugins_dir)
        runner = _load_runner(plugins_dir)

        def _load_module_must_not_be_called(plugin_id):
            raise AssertionError(
                "_load_module was called by cmd_analyze_plugin — this must NEVER happen. "
                "The analyzer uses ast.parse only."
            )

        runner._load_module = _load_module_must_not_be_called

        # Must not raise AssertionError
        result = runner.COMMANDS["analyze_plugin"]({"plugin_id": plugin_id})
        assert result.get("ok") is True
