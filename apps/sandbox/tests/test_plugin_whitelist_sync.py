"""
Regression guard: for every plugin under plugins/, asserts that each function
declared in tools.json has a corresponding entry in that plugin's
manifest.toml [skills] keys.

DANGEROUS direction (flagged as error):
    tools.json declares a function  →  manifest [skills] keys is missing it
    → runner.py raises PermissionError silently; LLM call fails with no user
      feedback.

Safe direction (allowed, not flagged):
    manifest [skills] keys has an entry  →  no tools.json (or the function is
    absent from tools.json)
    → function is sandbox-callable but not LLM-exposed; this is intentional for
      helper functions used only by on_cycle hooks.

Plugins without plugin.py are skipped: runner.py's _load_module raises
FileNotFoundError before it even checks the whitelist, so those are a deeper
structural issue (incomplete implementation) tracked separately.
"""

import json
import tomllib
from pathlib import Path

import pytest

# Resolve the real plugins directory from this test file's location.
# Layout: apps/sandbox/tests/test_*.py → apps/sandbox/tests/ → apps/sandbox/ →
#         apps/ → repo root → plugins/
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_PLUGINS_DIR = _REPO_ROOT / "plugins"


def _extract_tool_names(raw: object) -> list[str]:
    """
    Extract tool function names from a tools.json payload.

    Supports two formats found in this repo:
      - Bare array:    [{"name": "fn", ...}, ...]
      - Wrapped dict:  {"tools": [{"name": "fn", ...}, ...]}

    Entries that are not dicts (malformed) are silently skipped.
    """
    tools_list: list = []
    if isinstance(raw, list):
        tools_list = raw
    elif isinstance(raw, dict) and "tools" in raw:
        tools_list = raw["tools"]

    names: list[str] = []
    for entry in tools_list:
        if isinstance(entry, dict):
            name = entry.get("name", "")
            if name:
                names.append(name)
    return names


def _plugin_cases() -> list:
    """
    Return parametrize tuples for every plugin that has all three of:
      - manifest.toml
      - tools.json  (defines LLM-callable tools)
      - plugin.py   (required by runner._load_module; absent → FileNotFoundError
                     before the whitelist is even checked, so those plugins are
                     skipped here as a deeper structural issue)
    """
    cases: list = []
    if not _PLUGINS_DIR.is_dir():
        return cases
    for plugin_dir in sorted(_PLUGINS_DIR.iterdir()):
        if not plugin_dir.is_dir():
            continue
        tools_json = plugin_dir / "tools.json"
        manifest = plugin_dir / "manifest.toml"
        plugin_py = plugin_dir / "plugin.py"
        if tools_json.exists() and manifest.exists() and plugin_py.exists():
            cases.append(
                pytest.param(
                    plugin_dir.name,
                    tools_json,
                    manifest,
                    id=plugin_dir.name,
                )
            )
    return cases


@pytest.mark.parametrize("plugin_id,tools_json_path,manifest_path", _plugin_cases())
def test_tools_json_entries_are_whitelisted(
    plugin_id: str, tools_json_path: Path, manifest_path: Path
) -> None:
    """
    Every function name declared in tools.json must appear in the plugin's
    manifest.toml [skills] keys list as '<plugin_id>.<fn_name>'.

    If it doesn't, runner.py (~line 317) raises PermissionError when the LLM
    attempts the call — the error is swallowed as a WARN and the user sees
    nothing.
    """
    with open(tools_json_path, encoding="utf-8") as fh:
        raw = json.load(fh)

    with open(manifest_path, "rb") as fh:
        manifest: dict = tomllib.load(fh)

    tool_names = _extract_tool_names(raw)
    allowed_keys: set[str] = set(manifest.get("skills", {}).get("keys", []))

    missing: list[str] = []
    for fn_name in tool_names:
        expected_key = f"{plugin_id}.{fn_name}"
        if expected_key not in allowed_keys:
            missing.append(expected_key)

    assert not missing, (
        f"Plugin '{plugin_id}': the following tools.json entries are NOT "
        f"whitelisted in manifest.toml [skills] keys and will silently fail "
        f"when the LLM calls them (PermissionError in runner.py):\n"
        + "\n".join(f"  missing: {k}" for k in sorted(missing))
        + f"\n\nCurrent [skills] keys: {sorted(allowed_keys)}"
    )
