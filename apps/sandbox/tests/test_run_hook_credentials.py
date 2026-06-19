"""
TDD test: cmd_run_hook must deliver context['credentials'] to hook functions,
and hooks must forward those credentials to inner scripts via _context.

RED phase (before fix):
- Test 1 (echo hook / runner): passes already — runner spreads context into ctx.
- Tests 2 & 3 (weekly-reporter / doctor hooks): FAIL because the hook run()
  functions call generate_and_send / run_diagnostics without forwarding _context,
  so credentials never reach those inner scripts.
"""
from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

import pytest

RUNNER_PATH = Path(__file__).parent.parent / "runner.py"
REPO_ROOT = Path(__file__).parent.parent.parent.parent
WEEKLY_REPORTER_HOOK = REPO_ROOT / "plugins" / "weekly-reporter" / "hooks" / "cycle.py"
DOCTOR_HOOK = REPO_ROOT / "plugins" / "doctor" / "hooks" / "cycle.py"


def _load_runner():
    spec = importlib.util.spec_from_file_location("runner_cred_test", RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["runner_cred_test"] = mod
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


def _load_hook_module(path: Path, module_name: str):
    """Load a hook module, registering it in sys.modules so dataclasses work."""
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    # Put the plugin root on sys.path so sibling imports resolve
    plugin_root = str(path.parent.parent)
    if plugin_root not in sys.path:
        sys.path.insert(0, plugin_root)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


def _make_echo_hook(hook_dir: Path, hook_name: str = "on_cycle") -> None:
    """Create a minimal hook that echoes back the credentials it received."""
    hooks_dir = hook_dir / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    hook_file = hooks_dir / f"{hook_name}.py"
    hook_file.write_text(
        f"""\
def {hook_name}(ctx):
    return {{
        "signals": [],
        "logs": [],
        "received_credentials": ctx.get("credentials", {{}})
    }}
"""
    )


def _make_manifest(plugin_dir: Path, plugin_id: str) -> None:
    manifest = plugin_dir / "manifest.toml"
    manifest.write_text(
        f"""\
[plugin]
id = "{plugin_id}"
name = "Echo Hook Test Plugin"
version = "0.1.0"
type = "extra"
"""
    )


@pytest.fixture()
def echo_plugin(plugins_dir: Path):
    """Set up a temporary plugin with an on_cycle hook that echoes credentials."""
    plugin_id = "echo-hook"
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir()
    _make_manifest(plugin_dir, plugin_id)
    _make_echo_hook(plugin_dir, "on_cycle")
    return plugin_id


# ---------------------------------------------------------------------------
# Test 1: Runner injects credentials into ctx dict (baseline — already green)
# ---------------------------------------------------------------------------


def test_run_hook_delivers_credentials_to_hook(echo_plugin, plugins_dir):
    """
    cmd_run_hook must inject context['credentials'] into the ctx dict passed to
    the hook's on_cycle function. The runner already spreads context into ctx —
    this test documents and protects that invariant.
    """
    runner = _load_runner()

    creds = {"MY_API_KEY": "secret123", "MY_API_SECRET": "topsecret"}
    req = {
        "cmd": "run_hook",
        "plugin_id": echo_plugin,
        "hook": "on_cycle",
        "context": {
            "operator": "test-operator",
            "credentials": creds,
        },
    }

    result = runner.cmd_run_hook(req)

    assert result.get("received_credentials") == creds, (
        f"Hook did not receive credentials. Got: {result.get('received_credentials')!r}"
    )


# ---------------------------------------------------------------------------
# Test 2: weekly-reporter hook forwards credentials to generate_and_send
# ---------------------------------------------------------------------------


def test_weekly_reporter_hook_forwards_credentials(monkeypatch):
    """
    weekly-reporter's run(ctx) must forward ctx['credentials'] to generate_and_send
    via _context so that TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are used from
    context rather than os.environ (which is empty in SANDBOX_STRICT mode).

    RED: before fix, generate_and_send is called without _context, so
    credentials are never delivered.
    """
    received: dict = {}

    def capturing_generate_and_send(args, _context=None):
        received["_context"] = _context
        return {"ok": False, "reason": "test", "telegram_sent": False}

    # Load the hook module fresh with sys.modules registration
    hook_mod = _load_hook_module(WEEKLY_REPORTER_HOOK, "wr_hook_cred_test")

    # Patch generate_and_send on the hook module (it imported it at load time)
    monkeypatch.setattr(hook_mod, "generate_and_send", capturing_generate_and_send)

    WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    today = WEEKDAYS[time.gmtime().tm_wday]

    creds = {"TELEGRAM_BOT_TOKEN": "tok123", "TELEGRAM_CHAT_ID": "chat456"}
    ctx = {
        "credentials": creds,
        "closed_trades": [],
        "equity_curve": [1.0],
        "plugin_config": {"weekly_report_day": today, "min_trades": 0},
    }

    hook_mod.run(ctx)

    assert received.get("_context") is not None, (
        "generate_and_send was called without _context — credentials never delivered"
    )
    ctx_obj = received["_context"]
    delivered = ctx_obj.metadata.get("credentials", {}) if hasattr(ctx_obj, "metadata") else {}
    assert delivered == creds, (
        f"generate_and_send received wrong credentials. Got: {delivered!r}"
    )


# ---------------------------------------------------------------------------
# Test 3: doctor hook forwards credentials to run_diagnostics
# ---------------------------------------------------------------------------


def test_doctor_hook_forwards_credentials(monkeypatch):
    """
    doctor's run(ctx) must forward ctx['credentials'] to run_diagnostics via
    _context so that check_credentials() uses the kernel-injected dict rather
    than os.environ (empty in sandbox).

    RED: before fix, run_diagnostics is called without _context so available_creds
    stays None and falls back to os.environ.
    """
    received: dict = {}

    def capturing_run_diagnostics(args, _context=None):
        received["_context"] = _context
        return {
            "ok": True,
            "timestamp": "2026-01-01T00:00:00Z",
            "checks": [],
            "summary": {"total": 0, "passed": 0, "failed": 0},
            "errors": [],
            "warnings": [],
        }

    hook_mod = _load_hook_module(DOCTOR_HOOK, "doctor_hook_cred_test")
    monkeypatch.setattr(hook_mod, "run_diagnostics", capturing_run_diagnostics)

    creds = {"ALPACA_API_KEY": "key999", "ALPACA_SECRET_KEY": "sec999"}
    ctx = {
        "credentials": creds,
        "active_plugin_ids": ["doctor"],
        "required_credentials": ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"],
        "plugin_config": {},
    }

    hook_mod.run(ctx)

    assert received.get("_context") is not None, (
        "run_diagnostics was called without _context — credentials never delivered"
    )
    ctx_obj = received["_context"]
    delivered = ctx_obj.metadata.get("credentials", {}) if hasattr(ctx_obj, "metadata") else {}
    assert delivered == creds, (
        f"run_diagnostics received wrong credentials. Got: {delivered!r}"
    )
