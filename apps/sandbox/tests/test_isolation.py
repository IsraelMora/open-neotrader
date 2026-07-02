"""
TDD tests for apps/sandbox/isolation.py.

Phase 5, Step 5.1 — written RED before implementation.
Phase 5, Step 5.5 — extended for network-only blocklist + os-exec neutralization.
Covers: SANDBOX_STRICT=true import blocking (network modules only), open() path restriction,
        SANDBOX_STRICT=false guard relaxation + structured warning,
        subprocess/multiprocessing NOT blocked (legit sci-libs need them),
        importlib.import_module also blocked, path-traversal open() denied.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
import sys
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
        "ftplib", "smtplib", "telnetlib", "httpx", "aiohttp",
        "websocket", "websockets",
    ):
        sys.modules.pop(mod_name, None)
    # Restore builtins.open if it was replaced
    import builtins
    if hasattr(builtins, "_nt_original_open"):
        builtins.open = builtins._nt_original_open  # type: ignore[attr-defined]
        del builtins._nt_original_open


class TestImportGuardStrict:
    """Under strict mode, network modules must raise ImportError."""

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

    def test_subprocess_NOT_blocked_under_strict(self):
        """
        import subprocess must SUCCEED under strict mode.
        subprocess/multiprocessing are needed by numpy/scipy/scikit-learn;
        blocking them in-process would break legitimate analysis plugins.
        OS-level containment (F5) handles process-exec confinement.
        """
        iso = _fresh_isolation()
        iso.install_import_guard()

        # Must not raise — subprocess is no longer in BLOCKED_MODULES
        import subprocess  # noqa: F401
        assert subprocess is not None

    def test_multiprocessing_not_in_blocklist(self):
        """
        multiprocessing must NOT be in BLOCKED_MODULES.
        We do not explicitly block it — scientific libs (numpy, scipy) depend on it.
        Note: on CPython 3.14+, multiprocessing.reduction imports socket internally,
        so `import multiprocessing` will fail when socket is blocked by the import
        guard. That is a transitive dependency failure, NOT a deliberate block.
        OS-level confinement (F5) is the correct layer for process-exec containment.
        """
        iso = _fresh_isolation()
        assert "multiprocessing" not in iso.BLOCKED_MODULES
        assert "multiprocessing.pool" not in iso.BLOCKED_MODULES
        assert "ctypes" not in iso.BLOCKED_MODULES
        assert "cffi" not in iso.BLOCKED_MODULES

    def test_third_party_http_libs_blocked(self):
        """
        Third-party HTTP/network egress libs must be blocked too, not just stdlib.
        urllib3 (the lib `requests` is built on) and pycurl are direct network
        egress vectors a plugin could import even though stdlib urllib is blocked.
        """
        iso = _fresh_isolation()
        assert "urllib3" in iso.BLOCKED_MODULES
        assert "pycurl" in iso.BLOCKED_MODULES

    def test_socket_via_importlib_blocked_under_strict(self):
        """
        importlib.import_module('socket') must also be blocked, not just
        the `import socket` statement — both paths go through sys.meta_path.
        """
        iso = _fresh_isolation()
        iso.install_import_guard()
        sys.modules.pop("socket", None)  # ensure not cached from above

        with pytest.raises(ImportError):
            importlib.import_module("socket")

    def test_dunder_import_socket_blocked_under_strict(self):
        """
        __import__('socket') must also be blocked under strict guard.
        """
        iso = _fresh_isolation()
        iso.install_import_guard()
        sys.modules.pop("socket", None)

        with pytest.raises(ImportError):
            __import__("socket")


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

        with pytest.raises(PermissionError), open("/etc/passwd"):  # noqa: WPS515
            pass

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

    def test_path_traversal_denied(self, tmp_path):
        """
        open('<allowed_root>/../../../etc/passwd') must be denied
        even though the path starts under the allowed root.
        Path.resolve() collapses traversal before the check.
        """
        iso = _fresh_isolation()
        plugin_dir = tmp_path / "plugin"
        plugin_dir.mkdir()
        iso.install_open_guard(allowed_roots=[plugin_dir])

        traversal = str(plugin_dir) + "/../../../etc/passwd"
        with pytest.raises(PermissionError), open(traversal):  # noqa: WPS515
            pass


# ---------------------------------------------------------------------------
# Tests: os-exec neutralization under SANDBOX_STRICT=true
# ---------------------------------------------------------------------------


class TestOsExecNeutralization:
    """
    Under strict mode, apply() must neutralize os.system, os.popen, and
    exec-family functions on the already-imported os module.
    Analysis plugins that use os.environ / os.path / os.getcwd are unaffected.
    """

    def setup_method(self):
        _cleanup_guards()
        os.environ["SANDBOX_STRICT"] = "true"

    def teardown_method(self):
        _cleanup_guards()
        os.environ.pop("SANDBOX_STRICT", None)
        # Restore os functions neutralized by isolation (if any)
        import importlib as il
        il.reload(os)  # reset os to its original state after each test

    def test_os_system_neutralized(self):
        """os.system must raise PermissionError after strict apply()."""
        iso = _fresh_isolation()
        iso.apply(strict=True, allowed_roots=[])

        with pytest.raises(PermissionError):
            os.system("echo hi")

    def test_os_popen_neutralized(self):
        """os.popen must raise PermissionError after strict apply()."""
        iso = _fresh_isolation()
        iso.apply(strict=True, allowed_roots=[])

        with pytest.raises(PermissionError):
            os.popen("echo hi")

    def test_os_environ_still_works(self):
        """os.environ access must NOT be blocked — plugins read config from env."""
        iso = _fresh_isolation()
        iso.apply(strict=True, allowed_roots=[])

        # Must not raise
        val = os.environ.get("PATH", "")
        assert isinstance(val, str)

    def test_os_path_still_works(self):
        """os.path.join must NOT be blocked — plugins use path helpers."""
        iso = _fresh_isolation()
        iso.apply(strict=True, allowed_roots=[])

        result = os.path.join("/tmp", "file.txt")
        assert result == "/tmp/file.txt"
