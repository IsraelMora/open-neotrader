"""
Shared fixtures for apps/sandbox tests.
"""
import os
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
