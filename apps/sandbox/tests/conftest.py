"""
Shared fixtures for apps/sandbox tests.
"""
import os
import tomllib
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture()
def plugins_dir(tmp_path):
    """Returns a temporary plugins directory and sets NEUROTRADER_PLUGINS_DIR."""
    plugins = tmp_path / "plugins"
    plugins.mkdir()
    os.environ["NEUROTRADER_PLUGINS_DIR"] = str(plugins)
    yield plugins
    # Cleanup: unset to avoid leaking into other tests
    os.environ.pop("NEUROTRADER_PLUGINS_DIR", None)


@pytest.fixture()
def make_plugin_dir(tmp_path):
    """
    Factory fixture for analyzer tests.

    Usage:
        plugin_dir, manifest = make_plugin_dir(
            plugin_py_src="import subprocess\n",
            manifest_dict={
                "plugin": {"id": "my-plugin", ...},
                "permissions": {"network": False},
                "hooks": {"on_activate": "hooks/on_activate.py"},
                "skills": {"keys": ["my-plugin.my_fn"]},
            },
            hooks={
                # key: hook name (must match hooks/<name>.py path)
                # value: source code to write into that file
                "on_activate": "def on_activate(ctx): pass\n",
            },
        )

    Returns (plugin_dir: Path, manifest: dict).

    - Writes plugin.toml (TOML-serialized manifest_dict) to plugin_dir/manifest.toml
    - Writes plugin.py with plugin_py_src
    - Creates hooks/ subdirectory and writes any hook files listed in hooks dict
    - Does NOT execute any plugin code
    """

    def _factory(
        plugin_py_src: str,
        manifest_dict: dict[str, Any],
        hooks: dict[str, str] | None = None,
    ) -> tuple[Path, dict[str, Any]]:
        plugin_id = manifest_dict.get("plugin", {}).get("id", "test-plugin")
        plugin_dir = tmp_path / "plugins" / plugin_id
        plugin_dir.mkdir(parents=True, exist_ok=True)

        # Write plugin.py
        (plugin_dir / "plugin.py").write_text(plugin_py_src, encoding="utf-8")

        # Write manifest.toml — serialize manifest_dict to TOML manually (stdlib tomllib
        # is read-only; we build TOML by hand to avoid adding tomli-w as a dep).
        toml_lines = _dict_to_toml(manifest_dict)
        (plugin_dir / "manifest.toml").write_text("\n".join(toml_lines) + "\n", encoding="utf-8")

        # Write hook files if provided
        if hooks:
            hooks_dir = plugin_dir / "hooks"
            hooks_dir.mkdir(exist_ok=True)
            for hook_name, hook_src in hooks.items():
                (hooks_dir / f"{hook_name}.py").write_text(hook_src, encoding="utf-8")

        # Re-read the manifest so the returned dict matches exactly what analyzer will read
        manifest_path = plugin_dir / "manifest.toml"
        with open(manifest_path, "rb") as f:
            parsed_manifest = tomllib.load(f)

        return plugin_dir, parsed_manifest

    return _factory


def _dict_to_toml(d: dict[str, Any], prefix: str = "") -> list[str]:
    """
    Minimal TOML serializer sufficient for test manifests.
    Handles: str, int, float, bool, list[str], nested dicts (as [section] headers).
    Does NOT handle: dates, arrays of tables, deeply nested lists.
    """
    lines: list[str] = []
    scalar_items: list[tuple[str, Any]] = []
    dict_items: list[tuple[str, dict]] = []

    for key, value in d.items():
        if isinstance(value, dict):
            dict_items.append((key, value))
        else:
            scalar_items.append((key, value))

    for key, value in scalar_items:
        lines.append(f"{key} = {_toml_value(value)}")

    for key, value in dict_items:
        section = f"{prefix}.{key}" if prefix else key
        lines.append(f"\n[{section}]")
        lines.extend(_dict_to_toml(value, prefix=section))

    return lines


def _toml_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return f'"{v}"'
    if isinstance(v, list):
        items = ", ".join(_toml_value(i) for i in v)
        return f"[{items}]"
    return f'"{v}"'
