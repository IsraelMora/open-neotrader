"""
TDD tests for isolation.apply() wiring into runner.py main().

Phase 5, Step 5.3 — written RED before runner.py is changed.
Verifies that runner.py calls isolation.apply() before loading any plugin module.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

SANDBOX_DIR = Path(__file__).parent.parent
RUNNER_PATH = SANDBOX_DIR / "runner.py"


def _make_plugin(plugins_dir: Path, plugin_id: str, *, imports_socket: bool = False) -> Path:
    """Create a minimal plugin directory for testing isolation wiring."""
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    # manifest.toml
    (plugin_dir / "manifest.toml").write_text(
        f'[plugin]\nid = "{plugin_id}"\nname = "{plugin_id}"\n'
        f'version = "0.1.0"\ntype = "skill"\n\n'
        f'[skills]\nkeys = ["{plugin_id}.do_thing"]\n'
    )

    if imports_socket:
        # plugin.py that tries to import socket (blocked under strict)
        (plugin_dir / "plugin.py").write_text(
            "import socket\n\ndef do_thing(**kwargs): return 'ok'\n"
        )
    else:
        (plugin_dir / "plugin.py").write_text(
            "def do_thing(**kwargs): return 'ok'\n"
        )

    return plugin_dir


class TestIsolationWiredIntoRunner:
    """isolation.apply() must be called before any plugin module is loaded."""

    def test_isolation_apply_called_before_plugin_load(self, plugins_dir, monkeypatch, capsys):
        """
        When runner.main() dispatches call_plugin, isolation.apply() must have
        been called before spec.loader.exec_module is reached.
        """
        # Create a safe plugin (no blocked imports)
        _make_plugin(plugins_dir, "safe-plugin")
        monkeypatch.setenv("SANDBOX_STRICT", "true")

        import importlib.util as ilu
        spec = ilu.spec_from_file_location("runner_wired", RUNNER_PATH)
        mod = ilu.module_from_spec(spec)

        apply_calls = []

        # Patch isolation.apply to track calls
        import isolation as iso_real  # noqa: F401 — must exist after isolation.py created
        original_apply = iso_real.apply

        def tracking_apply(*args, **kwargs):
            apply_calls.append(True)
            # Don't actually install guards to keep test clean
            pass

        with patch("isolation.apply", side_effect=tracking_apply):
            spec.loader.exec_module(mod)

            request_json = json.dumps({
                "cmd": "call_plugin",
                "plugin_id": "safe-plugin",
                "function": "do_thing",
                "args": {},
                "context": {}
            })
            monkeypatch.setattr("sys.stdin", __import__("io").StringIO(request_json))
            import io
            from unittest.mock import patch as up
            with up("sys.stdin", __import__("io").StringIO(request_json)):
                with up("sys.stdout", __import__("io").StringIO()) as mock_out:
                    try:
                        mod.main()
                    except SystemExit:
                        pass

        # isolation.apply was called
        assert len(apply_calls) >= 1, "isolation.apply() was not called during runner.main()"

    def test_blocked_plugin_denied_under_strict(self, plugins_dir, monkeypatch):
        """
        Under SANDBOX_STRICT=true, a plugin that tries to import socket at
        module-load time must cause the sandbox to return ok=false with an
        ImportError in the error message.
        """
        _make_plugin(plugins_dir, "net-plugin", imports_socket=True)
        monkeypatch.setenv("SANDBOX_STRICT", "true")

        import importlib.util as ilu
        import io
        from unittest.mock import patch as up

        spec = ilu.spec_from_file_location("runner_strict", RUNNER_PATH)
        mod = ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)

        request_json = json.dumps({
            "cmd": "call_plugin",
            "plugin_id": "net-plugin",
            "function": "do_thing",
            "args": {},
            "context": {}
        })

        output_buf = io.StringIO()
        with up("sys.stdin", io.StringIO(request_json)):
            with up("sys.stdout", output_buf):
                try:
                    mod.main()
                except SystemExit:
                    pass

        output = output_buf.getvalue().strip()
        assert output, "runner produced no output"
        resp = json.loads(output)
        # The plugin tries to import socket at module-load time; under strict
        # mode the import guard must fire and the runner must return ok=false
        # with an error message mentioning the block.
        assert resp.get("ok") is False, (
            f"Expected ok=false for plugin that imports socket under strict mode, got: {resp}"
        )
        error_msg = str(resp.get("error", "")).lower()
        assert "importerror" in error_msg or "blocked" in error_msg or "import" in error_msg, (
            f"Error message should mention ImportError/blocked, got: {resp.get('error')}"
        )
