"""
NeuroTrader Sandbox — Static AST Analyzer (F3-s1).

Pure-stdlib static analysis of plugin Python source files.
Uses ast.parse ONLY — NEVER imports or executes plugin code.

Entry point:
    analyze_plugin(plugin_dir: Path, manifest: dict) -> dict

Returns:
    {
        "ok": True,  # always True; errors become findings, not exceptions
        "findings": [
            {
                "severity": "warn" | "info",
                "category": str,
                "file": str,
                "line": int | None,
                "message": str,
            }
        ],
        "summary": {
            "warn_count": int,
            "info_count": int,
            "scanned_files": int,
            "findings_count": int,
            "by_category": dict[str, int],
            "by_severity": dict[str, int],
        },
    }

Finding categories (F3-s1 scope):
    risky_import    — subprocess / multiprocessing / ctypes / cffi imported
                      (the F1 GAP: these are NOT blocked by isolation.py at runtime
                       because scientific libs depend on them)
    dangerous_call  — eval / exec / compile / __import__ called
    network_mismatch — manifest.permissions.network is falsy AND plugin imports
                       a network-family module (socket, requests, httpx, …)
    missing_hook    — manifest [hooks] declares a file that does not exist on disk
    undefined_skill — manifest [skills].keys lists a function not defined in plugin.py
    parse_error     — file could not be parsed (SyntaxError / OSError); ok stays True
"""
from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Detection sets
# ---------------------------------------------------------------------------

# Modules that are NOT blocked by isolation.py (F1 does not block them because
# numpy/scipy/scikit-learn import them internally).  Their presence in plugin
# code is a static risk signal worth surfacing to operators.
RISKY_IMPORTS: frozenset[str] = frozenset(
    {"subprocess", "multiprocessing", "ctypes", "cffi"}
)

# Network-family module roots — mirror of isolation.BLOCKED_MODULES.
# Used ONLY for the permissions.network cross-check (network_mismatch).
# We do NOT re-flag them as risky_import because F1 already blocks them at runtime.
NETWORK_IMPORTS: frozenset[str] = frozenset(
    {
        "socket",
        "ssl",
        "urllib",
        "http",
        "ftplib",
        "smtplib",
        "requests",
        "urllib3",
        "pycurl",
        "httpx",
        "aiohttp",
        "websocket",
        "websockets",
    }
)

# Function-call names that indicate dynamic code execution.
# AST cannot catch importlib.import_module() or dynamic strings — document this
# as a known limitation; we flag what we can see in the literal AST.
DANGEROUS_CALLS: frozenset[str] = frozenset({"eval", "exec", "compile", "__import__"})


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _finding(
    severity: str,
    category: str,
    file: str,
    line: int | None,
    message: str,
) -> dict[str, Any]:
    return {
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "message": message,
    }


def _scan_file(path: Path, src: str) -> tuple[list[dict], set[str], set[str]]:
    """
    Parse `src` as Python source and walk its AST.

    Returns:
        (findings, network_roots_found, defined_fn_names)

    - findings: risky_import and dangerous_call findings from this file
    - network_roots_found: root module names from NETWORK_IMPORTS detected in this file
    - defined_fn_names: top-level FunctionDef names (for skills cross-check)

    Caller is responsible for catching SyntaxError / ValueError from ast.parse.
    """
    tree = ast.parse(src, filename=str(path))

    findings: list[dict] = []
    network_roots: set[str] = set()
    defined_fns: set[str] = set()
    file_label = path.name

    for node in ast.walk(tree):
        # ------------------------------------------------------------------
        # Import detection
        # ------------------------------------------------------------------
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in RISKY_IMPORTS:
                    findings.append(
                        _finding(
                            severity="warn",
                            category="risky_import",
                            file=file_label,
                            line=node.lineno,
                            message=(
                                f"Imports '{alias.name}' which is not blocked by the F1 runtime "
                                "sandbox but may be used for unsafe process execution. "
                                "Review whether this module is necessary."
                            ),
                        )
                    )
                if root in NETWORK_IMPORTS:
                    network_roots.add(root)

        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            root = module.split(".")[0]
            if root in RISKY_IMPORTS:
                findings.append(
                    _finding(
                        severity="warn",
                        category="risky_import",
                        file=file_label,
                        line=node.lineno,
                        message=(
                            f"Imports from '{module}' which is not blocked by the F1 runtime "
                            "sandbox but may enable unsafe process execution."
                        ),
                    )
                )
            if root in NETWORK_IMPORTS:
                network_roots.add(root)

        # ------------------------------------------------------------------
        # Dangerous call detection
        # ------------------------------------------------------------------
        elif isinstance(node, ast.Call):
            func = node.func
            fn_id: str | None = None
            if isinstance(func, ast.Name):
                fn_id = func.id
            # Note: ast.Attribute (e.g. builtins.eval) is intentionally not
            # covered here — catching the bare name is already high-signal.
            if fn_id and fn_id in DANGEROUS_CALLS:
                findings.append(
                    _finding(
                        severity="warn",
                        category="dangerous_call",
                        file=file_label,
                        line=node.lineno,
                        message=(
                            f"Calls '{fn_id}()' which executes arbitrary code at runtime. "
                            "Dynamic code execution is a significant security risk in plugins."
                        ),
                    )
                )

        # ------------------------------------------------------------------
        # Top-level function collection (for skills cross-check)
        # ------------------------------------------------------------------
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Collect ALL function names (not just top-level) so nested helpers
            # in plugins don't cause false-positive undefined_skill findings.
            defined_fns.add(node.name)

    return findings, network_roots, defined_fns


def _check_network_declaration(
    manifest: dict, network_roots_found: set[str]
) -> dict | None:
    """
    Cross-check: manifest declares permissions.network=false (or absent) but
    plugin imports a network-family module → network_mismatch finding.
    """
    permissions = manifest.get("permissions", {})
    # Treat missing key, None, False, 0, "" as "no network permission"
    network_permitted = bool(permissions.get("network", False))
    if not network_permitted and network_roots_found:
        mods = ", ".join(sorted(network_roots_found))
        return _finding(
            severity="warn",
            category="network_mismatch",
            file="plugin.py",
            line=None,
            message=(
                f"Plugin declares permissions.network=false but imports network module(s): "
                f"{mods}. These imports are blocked by the F1 sandbox at runtime, but the "
                "manifest should accurately declare network requirements."
            ),
        )
    return None


def _check_hook_files(plugin_dir: Path, manifest: dict) -> list[dict]:
    """
    Cross-check: for each hook declared in manifest [hooks], verify the file
    exists on disk.  Missing files → missing_hook finding.
    """
    findings: list[dict] = []
    hooks_cfg: dict = manifest.get("hooks", {})
    for hook_name, hook_path_rel in hooks_cfg.items():
        hook_path = plugin_dir / hook_path_rel
        if not hook_path.exists():
            findings.append(
                _finding(
                    severity="warn",
                    category="missing_hook",
                    file=str(hook_path_rel),
                    line=None,
                    message=(
                        f"Hook '{hook_name}' declares file '{hook_path_rel}' "
                        "but the file does not exist on disk. "
                        "The hook will silently not run at activation/deactivation time."
                    ),
                )
            )
    return findings


def _check_skill_defs(manifest: dict, defined_fn_names: set[str]) -> list[dict]:
    """
    Cross-check: for each key in manifest [skills].keys, extract the bare
    function name (last segment after '.') and verify it appears in the
    collected FunctionDef names from plugin.py.

    Missing → undefined_skill finding.
    """
    findings: list[dict] = []
    skills_cfg: dict = manifest.get("skills", {})
    keys: list[str] = skills_cfg.get("keys", [])
    for key in keys:
        fn_name = key.split(".")[-1]
        if fn_name not in defined_fn_names:
            findings.append(
                _finding(
                    severity="warn",
                    category="undefined_skill",
                    file="plugin.py",
                    line=None,
                    message=(
                        f"Skill key '{key}' references function '{fn_name}' "
                        "which is not defined in plugin.py. "
                        "Calling this skill at runtime will raise AttributeError."
                    ),
                )
            )
    return findings


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def analyze_plugin(plugin_dir: Path, manifest: dict) -> dict:
    """
    Analyze a plugin directory using AST-only static analysis.

    NEVER imports or executes plugin code — uses ast.parse exclusively.

    Args:
        plugin_dir: Path to the plugin directory (must contain plugin.py)
        manifest:   Parsed manifest dict (from tomllib.load)

    Returns:
        Structured scan_result dict; ok is always True.
    """
    all_findings: list[dict] = []
    all_network_roots: set[str] = set()
    all_defined_fns: set[str] = set()
    scanned_files: int = 0

    # Collect files to scan: plugin.py + hooks/*.py
    files_to_scan: list[Path] = []
    plugin_py = plugin_dir / "plugin.py"
    if plugin_py.exists():
        files_to_scan.append(plugin_py)

    hooks_dir = plugin_dir / "hooks"
    if hooks_dir.is_dir():
        files_to_scan.extend(sorted(hooks_dir.glob("*.py")))

    for py_file in files_to_scan:
        try:
            src = py_file.read_text(encoding="utf-8", errors="replace")
            file_findings, net_roots, fn_names = _scan_file(py_file, src)
            all_findings.extend(file_findings)
            all_network_roots.update(net_roots)
            all_defined_fns.update(fn_names)
            scanned_files += 1
        except SyntaxError as exc:
            all_findings.append(
                _finding(
                    severity="warn",
                    category="parse_error",
                    file=py_file.name,
                    line=exc.lineno,
                    message=f"Python syntax error: {exc.msg} (line {exc.lineno})",
                )
            )
            # Count the file as "attempted"
            scanned_files += 1
        except OSError as exc:
            all_findings.append(
                _finding(
                    severity="warn",
                    category="parse_error",
                    file=py_file.name,
                    line=None,
                    message=f"Could not read file: {exc}",
                )
            )
            scanned_files += 1

    # Cross-checks
    net_finding = _check_network_declaration(manifest, all_network_roots)
    if net_finding:
        all_findings.append(net_finding)

    all_findings.extend(_check_hook_files(plugin_dir, manifest))
    all_findings.extend(_check_skill_defs(manifest, all_defined_fns))

    # Build summary
    warn_count = sum(1 for f in all_findings if f["severity"] in ("warn", "warning"))
    info_count = sum(1 for f in all_findings if f["severity"] == "info")

    by_category: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    for f in all_findings:
        by_category[f["category"]] = by_category.get(f["category"], 0) + 1
        by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1

    return {
        "ok": True,
        "findings": all_findings,
        "summary": {
            "warn_count": warn_count,
            "info_count": info_count,
            "scanned_files": scanned_files,
            "findings_count": len(all_findings),
            "by_category": by_category,
            "by_severity": by_severity,
        },
    }
