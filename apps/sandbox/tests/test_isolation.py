"""
TDD tests for apps/sandbox/isolation.py.

Phase 5, Step 5.1 — written RED before implementation.
Covers: SANDBOX_STRICT=true import blocking, open() path restriction,
        SANDBOX_STRICT=false guard relaxation + structured warning.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import sys
import os
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ISOLATION_PATH = Path(__file__).parent.parent / "isolation.py"


def _fresh_isolation():
    """
    Load isolation.py into a fresh module object each time so guard state
    does not bleed across tests.
    """
    spec = importlib.util.spec_from_file_location("isolation_under_test", ISOLATION_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


# ---------------------------------------------------------------------------
# Tests: SANDBOX_STRICT=true (import guard)
# ---------------------------------------------------------------------------


def _cleanup_guards():
    """Remove any _BlockingFinder entries from sys.meta_path and restore blocked modules."""
    sys.meta_path[:] = [
        f for f in sys.meta_path
        if type(f).__name__ != "_BlockingFinder"
    ]
    for mod_name in (
        "socket", "ssl", "requests", "urllib", "urllib.request",
        "urllib.parse", "urllib.error", "http", "http.client", "http.server",
        "ftplib", "smtplib", "subprocess", "multiprocessing",
        "multiprocessing.pool", "ctypes", "cffi",
    ):
        sys.modules.pop(mod_name, None)
    # Restore builtins.open if it was replaced
    import builtins
    if hasattr(builtins, "_nt_original_open"):
        builtins.open = builtins._nt_original_open  # type: ignore[attr-defined]
        del builtins._nt_original_open


class TestImportGuardStrict:
    """Under strict mode, blocked modules must raise ImportError."""

    def setup_method(self):
        _cleanup_guards()
        os.environ["SANDBOX_STRICT"] = "true"

    def teardown_method(self):
        _cleanup_guards()
        os.environ.pop("SANDBOX_STRICT", None)

    def test_socket_blocked_under_strict(self):
        """import socket must raise ImportError when strict guard is installed."""
        iso = _fresh_isolation()
        iso.install_import_guard()

        with pytest.raises(ImportError):
            import socket  # noqa: F401 — intentional blocked import

    def test_requests_blocked_under_strict(self):
        """import requests must raise ImportError when strict guard is installed."""
        iso = _fresh_isolation()
        iso.install_import_guard()

        with pytest.raises(ImportError):
            import requests  # noqa: F401

    def test_subprocess_blocked_under_strict(self):
        """import subprocess must raise ImportError when strict guard is installed."""
        iso = _fresh_isolation()
        iso.install_import_guard()

        with pytest.raises(ImportError):
            import subprocess  # noqa: F401


# ---------------------------------------------------------------------------
# Tests: SANDBOX_STRICT=false (guards relaxed + warning emitted)
# ---------------------------------------------------------------------------


class TestNonStrictMode:
    """Under non-strict mode, imports succeed and a structured warning is emitted."""

    def setup_method(self):
        _cleanup_guards()
        os.environ["SANDBOX_STRICT"] = "false"

    def teardown_method(self):
        _cleanup_guards()
        os.environ.pop("SANDBOX_STRICT", None)

    def test_socket_succeeds_in_non_strict(self, capsys):
        """Under SANDBOX_STRICT=false, import socket must succeed."""
        # Restore socket in case a prior test blocked it
        sys.modules.pop("socket", None)

        iso = _fresh_isolation()
        iso.apply(strict=False, allowed_roots=[])

        import socket  # noqa: F401 — must NOT raise
        assert socket is not None

    def test_non_strict_warning_emitted(self, capsys):
        """
        Under SANDBOX_STRICT=false, apply() must emit a structured JSON warning
        to stderr listing exactly what is relaxed.
        """
        iso = _fresh_isolation()
        iso.apply(strict=False, allowed_roots=[])

        captured = capsys.readouterr()
        # Warning must go to stderr
        assert captured.err, "Expected a warning on stderr when SANDBOX_STRICT=false"

        # Warning must be valid JSON
        warning = json.loads(captured.err.strip().splitlines()[-1])
        assert warning.get("level") == "warn"
        assert "relaxed" in warning
        relaxed = warning["relaxed"]
        assert "import_guard" in relaxed
        assert "open_guard" in relaxed


# ---------------------------------------------------------------------------
# Tests: open() path restriction under SANDBOX_STRICT=true
# ---------------------------------------------------------------------------


class TestOpenGuardStrict:
    """Path-restricted open() under strict mode."""

    def setup_method(self):
        _cleanup_guards()
        os.environ["SANDBOX_STRICT"] = "true"

    def teardown_method(self):
        _cleanup_guards()
        os.environ.pop("SANDBOX_STRICT", None)

    def test_open_outside_allowed_root_raises(self, tmp_path):
        """open('/etc/passwd') must raise PermissionError under strict open guard."""
        iso = _fresh_isolation()
        allowed = tmp_path / "plugin"
        allowed.mkdir()
        iso.install_open_guard(allowed_roots=[allowed])

        with pytest.raises(PermissionError):
            open("/etc/passwd")  # noqa: WPS515

    def test_open_inside_allowed_root_succeeds(self, tmp_path):
        """open() of a file within the allowed root must succeed."""
        iso = _fresh_isolation()
        plugin_dir = tmp_path / "plugin"
        plugin_dir.mkdir()
        target = plugin_dir / "config.json"
        target.write_text("{}")

        iso.install_open_guard(allowed_roots=[plugin_dir])

        # Must not raise
        with open(str(target)) as fh:
            content = fh.read()
        assert content == "{}"
