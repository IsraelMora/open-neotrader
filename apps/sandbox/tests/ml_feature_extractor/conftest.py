"""
Fixtures for ml_feature_extractor tests.

Provides a sys.path restore guard so that paths added by _load_plugin() /
_load_model() (e.g. packages/plugin-sdk, plugins/ml-feature-extractor/scripts)
do not leak onto sys.path for tests outside this directory.
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _restore_sys_path():
    """Snapshot sys.path before each test and restore it after."""
    original = sys.path[:]
    yield
    sys.path[:] = original
