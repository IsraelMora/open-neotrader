"""
TDD tests for runner.py cmd_smoke_test + _classify (F3-s2).

Phase 2 RED: tests fail because cmd_smoke_test and _classify do not exist yet.
Phase 2 GREEN: implement _classify and cmd_smoke_test in runner.py.

Contract (spec AC-1 through AC-9):
  - Clean plugin → result='passed', all checks passed
  - on_activate raises KeyError('API_KEY') → result='inconclusive'
  - on_activate message contains 'credential' / 'missing' → result='inconclusive'
  - SyntaxError / ImportError in plugin.py → result='failed'
  - Declared skill fn missing → result='failed'
  - Skill fn wrong signature (TypeError) → result='failed'
  - Absent on_activate → that check 'passed'
  - Worst-of aggregation: failed > inconclusive > passed
  - Missing plugin dir (FileNotFoundError) propagates; caller (main) wraps → ok=false

F5-s1 regression: cmd_smoke_test must use the REAL SDK Context shape (plugin_id,
operator, metadata only) so smoke results are faithful in production.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

# Path to real neurotrader_sdk package (packages/plugin-sdk)
_SDK_PATH = Path(__file__).parent.parent.parent.parent / "packages" / "plugin-sdk"

# SDK-related module names that the real-Context test injects and must clean up.
_SDK_MODULE_NAMES = (
    "neurotrader_sdk",
    "neurotrader_sdk.context",
    "neurotrader_sdk.decorators",
)

SANDBOX_DIR = Path(__file__).parent.parent
RUNNER_PATH = SANDBOX_DIR / "runner.py"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def restore_builtins_open():
    """
    Restore builtins.open to the original if isolation.install_open_guard() was
    called by a prior test in this session (test_runner_isolation leak).
    The original is stored as builtins._nt_original_open by isolation.py.
    """
    import builtins
    original = getattr(builtins, "_nt_original_open", None)
    if original is not None:
        builtins.open = original
    yield
    # No teardown needed — open stays original for subsequent tests


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_runner(plugins_dir: Path):
    """Load a fresh runner module instance pointed at plugins_dir."""
    os.environ["NEUROTRADER_PLUGINS_DIR"] = str(plugins_dir)
    mod_name = f"runner_smoke_{id(plugins_dir)}"
    spec = importlib.util.spec_from_file_location(mod_name, RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    mod.PLUGINS_DIR = plugins_dir
    # Disable in-process resource limits: _apply_resource_limits() would cap
    # the pytest process (RLIMIT_AS=512MB) and break once heavy ML libs are
    # loaded. Enforcement is verified in isolation via test_rlimit_nproc.py
    # subprocesses; in-process main() calls must skip it.
    mod._apply_resource_limits = lambda: None
    return mod


def _make_manifest_toml(plugin_id: str, skills: list[str] | None = None, hooks: dict | None = None) -> str:
    """Build minimal manifest.toml TOML content."""
    skill_list = skills or []
    keys_toml = ", ".join(f'"{k}"' for k in skill_list)
    lines = [
        "[plugin]",
        f'id = "{plugin_id}"',
        f'name = "Test {plugin_id}"',
        'version = "0.1.0"',
        'type = "skill"',
        "",
        "[skills]",
        f"keys = [{keys_toml}]",
    ]
    if hooks:
        lines.append("")
        lines.append("[hooks]")
        for hook_name, hook_path in hooks.items():
            lines.append(f'{hook_name} = "{hook_path}"')
    return "\n".join(lines) + "\n"


def _make_clean_plugin(plugins_dir: Path, plugin_id: str = "clean-plugin") -> Path:
    """
    Clean plugin: valid manifest, working on_activate, one declared + defined skill.
    AC-1: all checks pass → result='passed'.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id, skills=[f"{plugin_id}.my_fn"]),
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "def my_fn(signal=None, _context=None, **kwargs):\n    return 'ok'\n",
        encoding="utf-8",
    )
    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir(exist_ok=True)
    (hooks_dir / "on_activate.py").write_text(
        "def on_activate(ctx):\n    return {'ok': True}\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_no_hooks(plugins_dir: Path, plugin_id: str = "no-hooks-plugin") -> Path:
    """
    Plugin with no on_activate hook file.
    AC: on_activate check → 'passed' (absent hook is fine).
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id, skills=[f"{plugin_id}.my_fn"]),
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "def my_fn(signal=None, _context=None, **kwargs):\n    return 'ok'\n",
        encoding="utf-8",
    )
    # No hooks/ directory at all
    return plugin_dir


def _make_plugin_keyerror_activate(plugins_dir: Path, plugin_id: str = "keyerror-plugin") -> Path:
    """
    on_activate raises KeyError('API_KEY') → inconclusive (missing credential).
    AC-2.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id, skills=[f"{plugin_id}.my_fn"]),
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "def my_fn(signal=None, _context=None, **kwargs):\n    return 'ok'\n",
        encoding="utf-8",
    )
    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir(exist_ok=True)
    (hooks_dir / "on_activate.py").write_text(
        "def on_activate(ctx):\n    raise KeyError('API_KEY')\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_credential_message(plugins_dir: Path, plugin_id: str = "cred-msg-plugin") -> Path:
    """
    on_activate raises ValueError with 'missing credential' in message → inconclusive.
    AC-2.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id),
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "pass\n",
        encoding="utf-8",
    )
    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir(exist_ok=True)
    (hooks_dir / "on_activate.py").write_text(
        "def on_activate(ctx):\n    raise ValueError('missing credential for this plugin')\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_syntax_error(plugins_dir: Path, plugin_id: str = "syntax-plugin") -> Path:
    """
    plugin.py has SyntaxError → result='failed'.
    AC-3.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id, skills=[f"{plugin_id}.my_fn"]),
        encoding="utf-8",
    )
    # Intentional syntax error
    (plugin_dir / "plugin.py").write_text(
        "def my_fn(\n    THIS IS INVALID PYTHON SYNTAX\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_import_error_activate(plugins_dir: Path, plugin_id: str = "importerr-plugin") -> Path:
    """
    on_activate raises ImportError → result='failed'.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id),
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "pass\n",
        encoding="utf-8",
    )
    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir(exist_ok=True)
    (hooks_dir / "on_activate.py").write_text(
        "def on_activate(ctx):\n    raise ImportError('cannot import broken_module')\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_missing_skill_fn(plugins_dir: Path, plugin_id: str = "missing-fn-plugin") -> Path:
    """
    Manifest declares a skill fn that is NOT defined in plugin.py → result='failed'.
    AC-4.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id, skills=[f"{plugin_id}.nonexistent_fn"]),
        encoding="utf-8",
    )
    # plugin.py does NOT define nonexistent_fn
    (plugin_dir / "plugin.py").write_text(
        "def other_fn():\n    return 'ok'\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_wrong_signature(plugins_dir: Path, plugin_id: str = "bad-sig-plugin") -> Path:
    """
    Skill fn has wrong signature (no signal/context params) → TypeError → 'failed'.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id, skills=[f"{plugin_id}.my_fn"]),
        encoding="utf-8",
    )
    # my_fn takes no args; calling fn(signal={}, _context=ctx) will raise TypeError
    (plugin_dir / "plugin.py").write_text(
        "def my_fn():\n    return 'ok'\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_mixed_checks(plugins_dir: Path, plugin_id: str = "mixed-plugin") -> Path:
    """
    Plugin with two skill keys: one defined (passed), one missing (failed).
    Worst-of: failed.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(
            plugin_id,
            skills=[f"{plugin_id}.good_fn", f"{plugin_id}.missing_fn"],
        ),
        encoding="utf-8",
    )
    # Only good_fn is defined
    (plugin_dir / "plugin.py").write_text(
        "def good_fn(signal=None, _context=None, **kwargs):\n    return 'ok'\n",
        encoding="utf-8",
    )
    return plugin_dir


def _make_plugin_inconclusive_and_passed(
    plugins_dir: Path, plugin_id: str = "inc-pass-plugin"
) -> Path:
    """
    on_activate raises KeyError (inconclusive); skill fn passes.
    Worst-of: inconclusive.
    """
    plugin_dir = plugins_dir / plugin_id
    plugin_dir.mkdir(parents=True, exist_ok=True)

    (plugin_dir / "manifest.toml").write_text(
        _make_manifest_toml(plugin_id, skills=[f"{plugin_id}.my_fn"]),
        encoding="utf-8",
    )
    (plugin_dir / "plugin.py").write_text(
        "def my_fn(signal=None, _context=None, **kwargs):\n    return 'ok'\n",
        encoding="utf-8",
    )
    hooks_dir = plugin_dir / "hooks"
    hooks_dir.mkdir(exist_ok=True)
    (hooks_dir / "on_activate.py").write_text(
        "def on_activate(ctx):\n    raise KeyError('API_KEY')\n",
        encoding="utf-8",
    )
    return plugin_dir


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSmokeTestClean:
    """AC-1: Clean plugin → all checks pass, result='passed'."""

    def test_clean_plugin_result_passed(self, plugins_dir):
        _make_clean_plugin(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "clean-plugin"})

        assert result["ok"] is True, f"Expected ok=True, got: {result}"
        assert result["result"] == "passed", f"Expected 'passed', got: {result['result']}"
        assert isinstance(result["checks"], list), "checks must be a list"
        statuses = [c["status"] for c in result["checks"]]
        assert all(s == "passed" for s in statuses), f"All checks must pass, got: {statuses}"


class TestSmokeTestInconclusive:
    """AC-2: Credential-dependent errors → inconclusive."""

    def test_keyerror_on_activate_inconclusive(self, plugins_dir):
        _make_plugin_keyerror_activate(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "keyerror-plugin"})

        assert result["ok"] is True
        assert result["result"] == "inconclusive", (
            f"KeyError on on_activate must → 'inconclusive', got: {result['result']}"
        )
        # The on_activate check must be 'failed' (individual check) with inconclusive overall
        on_act_checks = [c for c in result["checks"] if c["name"] == "on_activate"]
        assert len(on_act_checks) == 1
        assert on_act_checks[0]["status"] == "inconclusive"

    def test_credential_message_in_valueerror_inconclusive(self, plugins_dir):
        _make_plugin_credential_message(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "cred-msg-plugin"})

        assert result["ok"] is True
        assert result["result"] == "inconclusive", (
            f"ValueError with 'credential' message must → 'inconclusive', got: {result['result']}"
        )


class TestSmokeTestFailed:
    """AC-3 + AC-4: Structural defects → failed."""

    def test_syntax_error_in_plugin_py_failed(self, plugins_dir):
        _make_plugin_syntax_error(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "syntax-plugin"})

        assert result["ok"] is True
        assert result["result"] == "failed", (
            f"SyntaxError in plugin.py must → 'failed', got: {result['result']}"
        )

    def test_importerror_on_activate_failed(self, plugins_dir):
        _make_plugin_import_error_activate(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "importerr-plugin"})

        assert result["ok"] is True
        assert result["result"] == "failed", (
            f"ImportError on on_activate must → 'failed', got: {result['result']}"
        )

    def test_undefined_skill_fn_failed(self, plugins_dir):
        """AC-4: declared skill fn not in plugin.py → failed."""
        _make_plugin_missing_skill_fn(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "missing-fn-plugin"})

        assert result["ok"] is True
        assert result["result"] == "failed", (
            f"Undefined skill fn must → 'failed', got: {result['result']}"
        )
        # The skill check for nonexistent_fn must be 'failed'
        skill_checks = [
            c for c in result["checks"]
            if c["name"] not in ("manifest", "on_activate")
        ]
        assert any(c["status"] == "failed" for c in skill_checks), (
            f"At least one skill check must be 'failed': {skill_checks}"
        )

    def test_wrong_signature_skill_fn_failed(self, plugins_dir):
        """TypeError on calling skill fn → 'failed'."""
        _make_plugin_wrong_signature(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "bad-sig-plugin"})

        assert result["ok"] is True
        assert result["result"] == "failed", (
            f"TypeError from bad signature must → 'failed', got: {result['result']}"
        )


class TestSmokeTestAbsentHook:
    """Absent on_activate → that check 'passed' (absence is fine)."""

    def test_absent_on_activate_check_passed(self, plugins_dir):
        _make_plugin_no_hooks(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "no-hooks-plugin"})

        assert result["ok"] is True
        on_act_checks = [c for c in result["checks"] if c["name"] == "on_activate"]
        assert len(on_act_checks) == 1
        assert on_act_checks[0]["status"] == "passed", (
            f"Absent on_activate must → 'passed', got: {on_act_checks[0]}"
        )


class TestSmokeTestWorstOf:
    """Worst-of aggregation: failed > inconclusive > passed."""

    def test_one_failed_one_passed_overall_failed(self, plugins_dir):
        _make_plugin_mixed_checks(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "mixed-plugin"})

        assert result["ok"] is True
        assert result["result"] == "failed", (
            f"One failed check must → overall 'failed', got: {result['result']}"
        )

    def test_inconclusive_and_passed_overall_inconclusive(self, plugins_dir):
        _make_plugin_inconclusive_and_passed(plugins_dir)
        runner = _load_runner(plugins_dir)

        result = runner.COMMANDS["smoke_test"]({"plugin_id": "inc-pass-plugin"})

        assert result["ok"] is True
        assert result["result"] == "inconclusive", (
            f"Inconclusive + passed must → overall 'inconclusive', got: {result['result']}"
        )


class TestSmokeTestMissingDir:
    """AC-9: Missing plugin dir → FileNotFoundError (propagates; caller wraps to ok=false)."""

    def test_missing_plugin_dir_raises(self, plugins_dir):
        runner = _load_runner(plugins_dir)

        with pytest.raises(FileNotFoundError):
            runner.COMMANDS["smoke_test"]({"plugin_id": "nonexistent-plugin"})

    def test_missing_plugin_dir_via_main_json(self, plugins_dir, monkeypatch):
        """Via main() JSON protocol → ok=false response (never propagates to caller)."""
        import io

        runner = _load_runner(plugins_dir)

        request_json = json.dumps({"cmd": "smoke_test", "plugin_id": "nonexistent-plugin"})
        output_buf = io.StringIO()

        monkeypatch.setenv("SANDBOX_STRICT", "false")

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
        assert output, "Runner produced no stdout for missing plugin"
        resp = json.loads(output)
        assert resp.get("ok") is False, f"Missing plugin via main must → ok=false, got: {resp}"


class TestSmokeTestDispatch:
    """smoke_test registered in COMMANDS; JSON stdin dispatch works."""

    def test_smoke_test_in_commands(self, plugins_dir):
        runner = _load_runner(plugins_dir)
        assert "smoke_test" in runner.COMMANDS, "smoke_test must be registered in COMMANDS"

    def test_runner_dispatch_clean_plugin(self, plugins_dir, monkeypatch):
        """Full JSON stdin/stdout dispatch on a clean plugin → ok=True, checks shape."""
        import io

        _make_clean_plugin(plugins_dir, "dispatch-test-plugin")
        runner = _load_runner(plugins_dir)

        request_json = json.dumps({"cmd": "smoke_test", "plugin_id": "dispatch-test-plugin"})
        output_buf = io.StringIO()

        monkeypatch.setenv("SANDBOX_STRICT", "false")

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
        assert output, "Runner produced no stdout"
        resp = json.loads(output)
        assert resp.get("ok") is True, f"Expected ok=True, got: {resp}"
        inner = resp.get("result", {})
        assert "result" in inner, f"Expected 'result' field in inner, got: {inner}"
        assert "checks" in inner, f"Expected 'checks' field in inner, got: {inner}"


class TestSmokeTestRealSdkContext:
    """
    F5-s1 regression: cmd_smoke_test must work with the REAL SDK Context.

    In production, neurotrader_sdk is on PYTHONPATH so runner.py resolves
    _SdkContext to the real dataclass (plugin_id, operator, metadata only).
    The old code passed config=/credentials=/universe=/portfolio= to _SdkContext,
    which raises TypeError in production because the real Context dataclass does
    not accept those keyword arguments.

    This test exercises cmd_smoke_test with the real SDK on sys.path, so the real
    Context class is used, and asserts a clean plugin → result='passed' (not TypeError).
    """

    @pytest.fixture(autouse=True)
    def _isolate_sdk_state(self):
        """Snapshot and restore sys.path + SDK modules so this test doesn't pollute others."""
        path_snapshot = list(sys.path)
        modules_snapshot = {k: sys.modules.get(k) for k in _SDK_MODULE_NAMES}

        yield

        sys.path[:] = path_snapshot
        for name, original in modules_snapshot.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original

    def _load_runner_with_real_sdk(self, plugins_dir: Path):
        """Load a fresh runner with the real neurotrader_sdk on sys.path."""
        # Remove stale SDK modules so the fresh runner import picks up the real package
        for name in _SDK_MODULE_NAMES:
            sys.modules.pop(name, None)

        sdk_path = str(_SDK_PATH)
        if sdk_path not in sys.path:
            sys.path.insert(0, sdk_path)

        os.environ["NEUROTRADER_PLUGINS_DIR"] = str(plugins_dir)
        mod_name = f"runner_real_sdk_{id(plugins_dir)}"
        spec = importlib.util.spec_from_file_location(mod_name, RUNNER_PATH)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        mod.PLUGINS_DIR = plugins_dir
        return mod

    def test_clean_plugin_passes_with_real_sdk_context(self, plugins_dir):
        """
        RED (before fix): TypeError: Context.__init__() got unexpected keyword argument 'config'
        GREEN (after fix): result='passed', all checks pass, no TypeError.

        This is the latent production bug: cmd_smoke_test built _SdkContext with
        config=/credentials=/universe=/portfolio= kwargs that the real Context dataclass
        rejects. The fix must mirror the real execution paths in runner.py.
        """
        # Verify the real SDK is actually resolvable from _SDK_PATH
        assert (_SDK_PATH / "neurotrader_sdk" / "context.py").exists(), (
            f"Real SDK not found at {_SDK_PATH} — check path"
        )

        _make_clean_plugin(plugins_dir, "real-sdk-clean-plugin")
        runner = self._load_runner_with_real_sdk(plugins_dir)

        # Verify runner loaded the REAL Context (not the fallback **kw class)
        # The real Context is a dataclass; the fallback is not.
        import dataclasses
        assert dataclasses.is_dataclass(runner._SdkContext), (
            "runner._SdkContext must be the real dataclass when SDK is on sys.path; "
            "got the fallback **kw class — SDK path injection failed"
        )

        # This must NOT raise TypeError about unexpected kwargs
        result = runner.COMMANDS["smoke_test"]({"plugin_id": "real-sdk-clean-plugin"})

        assert result["ok"] is True, f"Expected ok=True, got: {result}"
        assert result["result"] == "passed", (
            f"Clean plugin with real SDK Context must → 'passed', got: {result['result']}. "
            f"Checks: {result.get('checks')}"
        )
