"""
Baseline smoke test: verifies that runner.py can be imported without
executing any plugins or requiring external dependencies beyond stdlib.

This is the first TDD test for the sandbox test harness (F1 PR1).
"""
import importlib.util
from pathlib import Path


RUNNER_PATH = Path(__file__).parent.parent / "runner.py"


def test_runner_module_exists():
    """runner.py must exist at the expected path."""
    assert RUNNER_PATH.exists(), f"runner.py not found at {RUNNER_PATH}"


def test_runner_can_be_imported():
    """
    runner.py must be importable without side effects.
    The module sets resource limits at import time but should not block.
    """
    spec = importlib.util.spec_from_file_location("runner_under_test", RUNNER_PATH)
    assert spec is not None, "Could not create module spec for runner.py"
    assert spec.loader is not None, "Module spec has no loader"

    module = importlib.util.module_from_spec(spec)
    # Loading runner.py applies OS resource limits (RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE)
    # and defines command handler functions — no plugins are executed.
    spec.loader.exec_module(module)  # type: ignore[attr-defined]

    # Verify core public symbols are available
    assert hasattr(module, "cmd_list_plugins"), "cmd_list_plugins not found in runner"
    assert hasattr(module, "cmd_call_plugin"), "cmd_call_plugin not found in runner"
    assert hasattr(module, "cmd_get_skills"), "cmd_get_skills not found in runner"
