"""
NeuroTrader Sandbox — Python in-process isolation guards.

Gated by SANDBOX_STRICT env var (default: true).
  strict=true  → import blocking + path-restricted open() active.
  strict=false → guards OFF; emits a structured JSON warning to stderr.

This is an in-process Python-level guard. It is NOT a substitute for
OS-level isolation (seccomp/bwrap/Docker --network=none), which is deferred
to F5. A determined attacker with access to native C extensions can bypass
in-process guards. The docs state this limitation explicitly (F1 contract).
"""
from __future__ import annotations

import builtins
import json
import os
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Blocked modules — network / process spawning / native FFI only.
# DO NOT block pandas, numpy, scipy, sklearn, json, math, datetime, etc.
# Those are legitimate plugin data-science dependencies.
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
        "requests",
        "subprocess",
        "multiprocessing",
        "multiprocessing.pool",
        "ctypes",
        "cffi",
    }
)


def install_import_guard() -> None:
    """
    Block BLOCKED_MODULES by setting each to None in sys.modules and
    installing a meta-path finder that rejects blocked names on any
    future import attempt (including submodule imports like http.client).

    Must be called BEFORE any plugin code is imported.
    """
    # Set existing module entries to None so `import X` raises ImportError
    for mod_name in BLOCKED_MODULES:
        sys.modules[mod_name] = None  # type: ignore[assignment]

    class _BlockingFinder:
        """sys.meta_path finder that denies blocked modules."""

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
                    "Network, process, and native-FFI imports are not permitted in the sandbox."
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
            except Exception:
                raise PermissionError(f"[sandbox] Cannot resolve path: {file!r}")

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


def apply(strict: bool, allowed_roots: list[Path]) -> None:
    """
    Main entry point. Called from runner.py main() after resource limits
    and before any plugin module is loaded.

    strict=True  (default) — install import guard + open guard.
    strict=False           — emit structured warning; guards are OFF.
    """
    if strict:
        install_import_guard()
        install_open_guard(allowed_roots)
        # Log activation to stderr so operators can confirm guards are on
        _warn(
            level="info",
            msg="SANDBOX_STRICT=true — import/network blocking + open() path restriction ACTIVE",
            relaxed=[],
        )
    else:
        _warn(
            level="warn",
            msg=(
                "SANDBOX_STRICT=false: import blocking + open() path restriction DISABLED. "
                "This mode is for bare-metal development only. "
                "DO NOT run in production with SANDBOX_STRICT=false."
            ),
            relaxed=["import_guard", "open_guard", "host_pythonpath"],
        )


def _warn(level: str, msg: str, relaxed: list[str]) -> None:
    """Emit a structured JSON log line to stderr."""
    record: dict = {"level": level, "msg": msg}
    if relaxed:
        record["relaxed"] = relaxed
    print(json.dumps(record), file=sys.stderr, flush=True)
