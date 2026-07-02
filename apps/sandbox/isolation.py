"""
NeuroTrader Sandbox — Python in-process isolation guards.

Gated by SANDBOX_STRICT env var (default: true).
  strict=true  → network-import blocking + os-exec neutralization +
                 path-restricted open() active.
  strict=false → guards OFF; emits a structured JSON warning to stderr.

What this does (in-process, Python-level):
  1. NETWORK-IMPORT BLOCKING: prevents plugins from importing standard-library
     and third-party network modules (socket, ssl, urllib, http, requests, …).
     Combined with the env-strip in buildSandboxEnv (PR2), a plugin cannot
     easily exfiltrate secrets even if it tries.
  2. OS-EXEC NEUTRALIZATION: replaces os.system, os.popen, and exec-family
     functions on the already-imported `os` module with stubs that raise
     PermissionError. This raises the bar for trivial process-launch attempts
     without breaking analysis plugins (none need os.system).
  3. PATH-RESTRICTED open(): reads outside allowed_roots and all writes raise
     PermissionError.

What this does NOT do:
  - subprocess, multiprocessing, ctypes, cffi are NOT blocked here.
    numpy/scipy/scikit-learn import them internally; blocking them in-process
    would break legitimate analysis plugins. subprocess.run() called from
    plugin code is a concern, but in-process blocking is not reliable against
    native C extensions anyway.
  - Full process-exec / network confinement is OS-level work (F5:
    seccomp / nsjail / Docker --network=none). A determined plugin using a
    not-yet-neutralized vector or a native C extension can bypass these
    in-process guards. F1 is defence-in-depth, not a security boundary.
"""
from __future__ import annotations

import builtins
import json
import os
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Blocked modules — NETWORK EGRESS only.
#
# Rule: only block modules whose primary purpose is network I/O. Do NOT block
# subprocess, multiprocessing, ctypes, cffi — those are imported internally by
# numpy/scipy/scikit-learn and blocking them breaks legitimate analysis plugins.
# OS-level containment (F5) is the right layer for process-exec confinement.
# ---------------------------------------------------------------------------
BLOCKED_MODULES: frozenset[str] = frozenset(
    {
        "socket",
        "ssl",
        "urllib",
        "urllib.request",
        "urllib.parse",
        "urllib.error",
        "http",
        "http.client",
        "http.server",
        "ftplib",
        "smtplib",
        "telnetlib",
        "requests",
        "urllib3",
        "pycurl",
        "httpx",
        "aiohttp",
        "websocket",
        "websockets",
    }
)


def install_import_guard() -> None:
    """
    Block network-egress modules by setting each to None in sys.modules and
    installing a meta-path finder that rejects blocked names on any
    future import attempt (including submodule imports like http.client and
    importlib.import_module / __import__ paths, which all go through
    sys.meta_path).

    Only NETWORK_EGRESS modules are blocked (see BLOCKED_MODULES).
    subprocess, multiprocessing, ctypes, cffi are intentionally NOT blocked —
    scientific libraries depend on them. Full process-exec confinement is F5.

    Must be called BEFORE any plugin code is imported.
    """
    # Set existing module entries to None so `import X` raises ImportError
    for mod_name in BLOCKED_MODULES:
        sys.modules[mod_name] = None  # type: ignore[assignment]

    class _BlockingFinder:
        """sys.meta_path finder that denies network-egress modules."""

        @staticmethod
        def find_spec(
            fullname: str,
            path: Any,
            target: Any = None,
        ) -> None:
            # Block exact names and any submodule whose root is blocked
            root = fullname.split(".")[0]
            if fullname in BLOCKED_MODULES or root in BLOCKED_MODULES:
                raise ImportError(
                    f"[sandbox] Module '{fullname}' is blocked under SANDBOX_STRICT=true. "
                    "Network-egress imports are not permitted in the sandbox. "
                    "(subprocess/multiprocessing/ctypes/cffi are allowed — use OS-level "
                    "confinement (F5) for process-exec containment.)"
                )
            return None

    # Prepend so our finder takes priority over all others
    sys.meta_path.insert(0, _BlockingFinder())  # type: ignore[arg-type]


def install_open_guard(allowed_roots: list[Path]) -> None:
    """
    Replace builtins.open with a path-restricted variant.

    Reads of any path whose realpath falls under one of allowed_roots are
    permitted. Writes and paths outside allowed_roots raise PermissionError.

    The original open() is preserved as builtins._nt_original_open so it
    can be restored in tests.
    """
    _original_open = builtins.open
    builtins._nt_original_open = _original_open  # type: ignore[attr-defined]

    _resolved_roots = [Path(r).resolve() for r in allowed_roots]

    def _restricted_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
        # Only restrict filesystem paths (str / Path), not file descriptors (int)
        if isinstance(file, (str, Path, bytes)):
            try:
                target = Path(file).resolve()
            except Exception as exc:
                raise PermissionError(f"[sandbox] Cannot resolve path: {file!r}") from exc

            # Allow reads under any allowed root
            if "w" not in mode and "a" not in mode and "x" not in mode:
                for root in _resolved_roots:
                    try:
                        target.relative_to(root)
                        return _original_open(file, mode, *args, **kwargs)
                    except ValueError:
                        continue
                raise PermissionError(
                    f"[sandbox] open('{file}') denied — path is outside allowed roots "
                    f"under SANDBOX_STRICT=true."
                )
            else:
                # Writes always denied
                raise PermissionError(
                    f"[sandbox] open('{file}', '{mode}') denied — writes are not permitted "
                    "in the sandbox."
                )

        # File descriptors and other non-path arguments pass through
        return _original_open(file, mode, *args, **kwargs)

    builtins.open = _restricted_open  # type: ignore[assignment]


def neutralize_os_exec() -> None:
    """
    Replace the obvious in-process process-launch functions on the already-
    imported `os` module with stubs that raise PermissionError.

    Covered: os.system, os.popen, os.fork, os.forkpty,
             os.execv, os.execve, os.execvp, os.execvpe.

    NOT touched: os.environ, os.path, os.getcwd, os.listdir, os.stat, etc.
    Analysis plugins need those; none need os.system.

    Note: this is defence-in-depth, not a security boundary. A plugin that
    has already imported subprocess before this call, or that uses a C
    extension, can still spawn processes. Full containment is OS-level (F5).
    """

    def _denied(name: str):  # type: ignore[return]
        def _stub(*args: Any, **kwargs: Any) -> Any:
            raise PermissionError(
                f"[sandbox] os.{name}() is not permitted under SANDBOX_STRICT=true. "
                "Use OS-level confinement (F5) for full process-exec containment."
            )
        _stub.__name__ = name
        return _stub

    for fn_name in ("system", "popen", "fork", "forkpty", "execv", "execve", "execvp", "execvpe"):
        if hasattr(os, fn_name):
            setattr(os, fn_name, _denied(fn_name))


def apply(strict: bool, allowed_roots: list[Path]) -> None:
    """
    Main entry point. Called from runner.py main() after resource limits
    and before any plugin module is loaded.

    strict=True  (default) — install network-import guard + os-exec
                             neutralization + open() path restriction.
    strict=False           — emit structured warning; guards are OFF.

    See module docstring for the full list of what is and is NOT contained.
    In particular: subprocess/multiprocessing are NOT blocked (sci-lib dep);
    full process-exec / network confinement requires OS-level work (F5).
    """
    if strict:
        install_import_guard()
        neutralize_os_exec()
        install_open_guard(allowed_roots)
        # Log activation to stderr so operators can confirm guards are on
        _warn(
            level="info",
            msg=(
                "SANDBOX_STRICT=true — network-import blocking + os-exec neutralization "
                "+ open() path restriction ACTIVE. "
                "Full confinement requires OS-level isolation (F5)."
            ),
            relaxed=[],
        )
    else:
        _warn(
            level="warn",
            msg=(
                "SANDBOX_STRICT=false: import blocking + os-exec neutralization "
                "+ open() path restriction DISABLED. "
                "This mode is for bare-metal development only. "
                "DO NOT run in production with SANDBOX_STRICT=false."
            ),
            relaxed=["import_guard", "os_exec_neutralization", "open_guard", "host_pythonpath"],
        )


def _warn(level: str, msg: str, relaxed: list[str]) -> None:
    """Emit a structured JSON log line to stderr."""
    record: dict = {"level": level, "msg": msg}
    if relaxed:
        record["relaxed"] = relaxed
    print(json.dumps(record), file=sys.stderr, flush=True)
