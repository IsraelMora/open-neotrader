"""
TDD integration test: cmd_run_hook must handle both raw-primitive [config] values
(e.g. fail_on_missing_credentials = false) and {default, type} ConfigFieldSpec dicts.

CRITICAL: doctor's manifest.toml uses raw primitives. Before the fix, cmd_run_hook
calls spec_data.get("default") on False/True/int values → AttributeError → ok:false
→ doctor stays dead silently.

RED phase (before fix): test_raw_primitive_config_ok FAILS with AttributeError.
GREEN phase (after fix): all tests pass.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

RUNNER_PATH = Path(__file__).parent.parent / "runner.py"
REPO_ROOT = Path(__file__).parent.parent.parent.parent


def _load_runner(plugins_dir: Path):
    """Load runner module fresh, pointing NEUROTRADER_PLUGINS_DIR at plugins_dir."""
    # Reload so PLUGINS_DIR picks up the env var set by conftest
    os.environ["NEUROTRADER_PLUGINS_DIR"] = str(plugins_dir)
    mod_name = f"runner_config_shape_{id(plugins_dir)}"
    spec = importlib.util.spec_from_file_location(mod_name, RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    # Patch PLUGINS_DIR on the loaded module to match the temp dir
    mod.PLUGINS_DIR = plugins_dir
    return mod


def _make_raw_primitive_plugin(plugins_dir: Path) -> str:
    """
    Create a minimal 'extra' plugin whose manifest uses raw-primitive [config]
    (exactly like doctor) and whose on_cycle hook returns ok:true with the
    effective_config injected into the result.
    """
    plugin_id = "raw-config-plugin"
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir()

    # manifest.toml: raw primitives (not {default, type} dicts)
    manifest = plugin_dir / "manifest.toml"
    manifest.write_text(
        """\
[plugin]
id = "raw-config-plugin"
name = "Raw Config Test Plugin"
version = "0.1.0"
type = "extra"

[scheduler]
mode = "polling"
timeframe = "1h"
stage = "pre"

[config]
fail_on_missing_credentials = false
max_retries = 3
label = "test"
"""
    )

    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir()
    hook_file = hooks_dir / "on_cycle.py"
    hook_file.write_text(
        """\
def on_cycle(ctx):
    return {
        "signals": [],
        "logs": [],
        "received_config": ctx.get("config", {}),
    }
"""
    )
    return plugin_id


def _make_dict_spec_plugin(plugins_dir: Path) -> str:
    """
    Create a plugin whose manifest uses {default, type} ConfigFieldSpec dicts
    (the other supported shape).
    """
    plugin_id = "dict-spec-plugin"
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir()

    manifest = plugin_dir / "manifest.toml"
    manifest.write_text(
        """\
[plugin]
id = "dict-spec-plugin"
name = "Dict Spec Test Plugin"
version = "0.1.0"
type = "extra"

[scheduler]
mode = "polling"
timeframe = "1h"
stage = "pre"

[config.timeout]
default = 30
type = "integer"

[config.enabled]
default = true
type = "boolean"
"""
    )

    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir()
    hook_file = hooks_dir / "on_cycle.py"
    hook_file.write_text(
        """\
def on_cycle(ctx):
    return {
        "signals": [],
        "logs": [],
        "received_config": ctx.get("config", {}),
    }
"""
    )
    return plugin_id


# ---------------------------------------------------------------------------
# Test 1 (CRITICAL — RED before fix): raw-primitive [config] → no AttributeError
# ---------------------------------------------------------------------------


def test_raw_primitive_config_ok(plugins_dir):
    """
    cmd_run_hook with a manifest using raw-primitive [config] values must return
    ok:true and invoke the hook successfully (not crash with AttributeError).

    This is the exact shape doctor uses:
        [config]
        fail_on_missing_credentials = false   ← False, not {default: false, type: ...}

    RED: before fix, False.get("default") → AttributeError → ok:false.
    GREEN: after fix, isinstance check routes correctly → hook runs → ok:true.
    """
    plugin_id = _make_raw_primitive_plugin(plugins_dir)
    runner = _load_runner(plugins_dir)

    req = {
        "cmd": "run_hook",
        "plugin_id": plugin_id,
        "hook": "on_cycle",
        "context": {"cycle_id": "test-001"},
    }

    result = runner.cmd_run_hook(req)

    assert "error" not in result or result.get("error") is None, (
        f"cmd_run_hook returned an error (expected ok): {result.get('error')}"
    )
    # Hook must have run and returned received_config
    assert "received_config" in result, (
        f"Hook did not run — result missing 'received_config'. Got: {result!r}"
    )
    cfg = result["received_config"]
    # Default values from raw primitives must be present
    assert cfg.get("fail_on_missing_credentials") is False, (
        f"Expected fail_on_missing_credentials=False, got: {cfg!r}"
    )
    assert cfg.get("max_retries") == 3, f"Expected max_retries=3, got: {cfg!r}"
    assert cfg.get("label") == "test", f"Expected label='test', got: {cfg!r}"


# ---------------------------------------------------------------------------
# Test 2: caller-supplied config overrides defaults (raw-primitive shape)
# ---------------------------------------------------------------------------


def test_raw_primitive_config_caller_override(plugins_dir):
    """
    Caller-supplied config in context must override the manifest raw-primitive defaults.
    """
    plugin_id = _make_raw_primitive_plugin(plugins_dir)
    runner = _load_runner(plugins_dir)

    req = {
        "cmd": "run_hook",
        "plugin_id": plugin_id,
        "hook": "on_cycle",
        "context": {
            "cycle_id": "test-002",
            "config": {"fail_on_missing_credentials": True, "max_retries": 10},
        },
    }

    result = runner.cmd_run_hook(req)

    assert "received_config" in result, f"Hook did not run. Got: {result!r}"
    cfg = result["received_config"]
    assert cfg.get("fail_on_missing_credentials") is True
    assert cfg.get("max_retries") == 10
    # label not overridden → stays at manifest default
    assert cfg.get("label") == "test"


# ---------------------------------------------------------------------------
# Test 3: {default, type} ConfigFieldSpec shape still resolves defaults correctly
# ---------------------------------------------------------------------------


def test_dict_spec_config_default_still_works(plugins_dir):
    """
    Manifests using the {default, type} ConfigFieldSpec shape must still work:
    cmd_run_hook must extract the 'default' key and apply it.

    Regression guard: fix must not break existing ConfigFieldSpec-style manifests.
    """
    plugin_id = _make_dict_spec_plugin(plugins_dir)
    runner = _load_runner(plugins_dir)

    req = {
        "cmd": "run_hook",
        "plugin_id": plugin_id,
        "hook": "on_cycle",
        "context": {"cycle_id": "test-003"},
    }

    result = runner.cmd_run_hook(req)

    assert "received_config" in result, f"Hook did not run. Got: {result!r}"
    cfg = result["received_config"]
    # Defaults extracted from {default: 30, type: integer} and {default: true, type: boolean}
    assert cfg.get("timeout") == 30, f"Expected timeout=30, got: {cfg!r}"
    assert cfg.get("enabled") is True, f"Expected enabled=True, got: {cfg!r}"
