"""
TDD tests for resolve_permitted_function() in runner.py.

Phase 6, Step 6.1 — written RED before implementation.
Covers: full-key exact match, cross-namespace suffix collision denial,
        undeclared function denial, single-skill plugin back-compat.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

RUNNER_PATH = Path(__file__).parent.parent / "runner.py"


def _load_runner():
    """Load runner.py as a module (fresh spec each call)."""
    spec = importlib.util.spec_from_file_location("runner_perm_test", RUNNER_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


class TestResolvePermittedFunction:
    """Unit tests for the pure helper resolve_permitted_function()."""

    def test_full_key_match_permits(self):
        """
        Full key 'plugin-b.get_bars' in declared_keys permits function 'get_bars'
        for plugin 'plugin-b'.
        """
        mod = _load_runner()
        fn = mod.resolve_permitted_function(
            declared_keys={"plugin-b.get_bars"},
            plugin_id="plugin-b",
            requested="get_bars",
        )
        assert fn == "get_bars"

    def test_cross_namespace_suffix_collision_denied(self):
        """
        plugin-a declares 'plugin-a.get_bars'. A call for plugin-b / get_bars
        must be DENIED — the suffix matches but the full key does not.
        """
        mod = _load_runner()
        with pytest.raises(PermissionError):
            mod.resolve_permitted_function(
                declared_keys={"plugin-a.get_bars"},
                plugin_id="plugin-b",
                requested="get_bars",
            )

    def test_undeclared_function_denied(self):
        """
        A function not declared in manifest.skills.keys at all must be denied.
        """
        mod = _load_runner()
        with pytest.raises(PermissionError):
            mod.resolve_permitted_function(
                declared_keys={"my-plugin.on_cycle"},
                plugin_id="my-plugin",
                requested="get_bars",
            )

    def test_single_skill_plugin_bare_name_resolves(self):
        """
        Back-compat: a plugin with exactly one declared skill allows the bare
        function name (last segment) to resolve unambiguously.
        e.g. declared={'rsi-analysis.analyze'}, plugin_id='rsi-analysis',
             requested='analyze' → 'analyze'
        """
        mod = _load_runner()
        fn = mod.resolve_permitted_function(
            declared_keys={"rsi-analysis.analyze"},
            plugin_id="rsi-analysis",
            requested="analyze",
        )
        assert fn == "analyze"

    def test_ambiguous_bare_name_denied(self):
        """
        If a bare name suffix matches more than one declared key for the same
        plugin, and there is no exact full-key match, the call must be denied.

        Scenario: plugin declares 'my-plugin.strategy.run' and 'my-plugin.fast.run'
        (both end with .run). Caller sends bare 'run' with no exact full-key
        match possible → ambiguous → PermissionError.
        """
        mod = _load_runner()
        with pytest.raises(PermissionError):
            mod.resolve_permitted_function(
                declared_keys={"my-plugin.strategy.run", "my-plugin.fast.run"},
                plugin_id="my-plugin",
                requested="run",
            )

    def test_full_qualified_key_always_wins(self):
        """
        Even if a plugin has multiple skills, passing the full qualified key
        'my-plugin.analyze' is always permitted.
        """
        mod = _load_runner()
        fn = mod.resolve_permitted_function(
            declared_keys={"my-plugin.analyze", "my-plugin.on_cycle"},
            plugin_id="my-plugin",
            requested="my-plugin.analyze",
        )
        assert fn == "analyze"
