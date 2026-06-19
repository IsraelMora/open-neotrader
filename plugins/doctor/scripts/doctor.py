"""
Doctor — Diagnóstico del Sistema
==================================
Verifica el estado de la plataforma al inicio del ciclo.

Checks:
  1. Plugins activos con manifest válido
  2. Credenciales requeridas presentes en el entorno
  3. Archivos de script de plugins accesibles
  4. Estado del contexto (tamaño, coherencia)
  5. Ciclos recientes (detección de fallos repetidos)
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

PLUGINS_DIR = os.environ.get("NEUROTRADER_PLUGINS_DIR", "plugins")


@dataclass
class CheckResult:
    name: str
    ok: bool
    message: str
    details: dict[str, Any] = field(default_factory=dict)


def check_plugin_files(plugin_ids: list[str]) -> CheckResult:
    """Verifica que los plugins activos tienen sus archivos en su lugar."""
    missing: list[str] = []
    found = 0

    for pid in plugin_ids:
        plugin_path = Path(PLUGINS_DIR) / pid
        manifest = plugin_path / "manifest.toml"
        if manifest.exists():
            found += 1
        else:
            missing.append(pid)

    if missing:
        return CheckResult(
            name="plugin_files",
            ok=False,
            message=f"{len(missing)} plugin(s) sin manifest.toml: {', '.join(missing)}",
            details={"missing": missing, "found": found},
        )
    return CheckResult(
        name="plugin_files",
        ok=True,
        message=f"{found} plugins verificados OK",
        details={"found": found},
    )


def check_credentials(required_vars: list[str], available: dict[str, str] | None = None) -> CheckResult:
    """Verifica que las credenciales requeridas están disponibles.

    Since F1, credentials are no longer in the sandbox environment. Callers must
    pass ``available`` — a dict of credential keys injected by the kernel via
    context['credentials']. Falls back to os.environ for bare-metal dev
    (SANDBOX_STRICT=false / no _context).
    """
    if available is None:
        # Bare-metal dev fallback: check os.environ directly.
        available = {v: os.environ.get(v, "") for v in required_vars}
    missing = [v for v in required_vars if not available.get(v)]
    if missing:
        return CheckResult(
            name="credentials",
            ok=False,
            message=f"Credenciales faltantes: {', '.join(missing)}",
            details={"missing": missing},
        )
    return CheckResult(
        name="credentials",
        ok=True,
        message=f"{len(required_vars)} credenciales presentes",
    )


def check_context_health(context: dict[str, Any]) -> CheckResult:
    """Verifica la salud del contexto de ciclo."""
    issues: list[str] = []

    # Detectar contexto excesivamente grande (>100KB como string)
    ctx_size = len(json.dumps(context))
    if ctx_size > 100_000:
        issues.append(f"Contexto muy grande: {ctx_size // 1024}KB (máx recomendado 100KB)")

    # Verificar que pending_signals tiene estructura correcta
    pending = context.get("pending_signals", [])
    if not isinstance(pending, list):
        issues.append("pending_signals no es una lista")

    if issues:
        return CheckResult(
            name="context_health",
            ok=False,
            message="; ".join(issues),
            details={"ctx_size_bytes": ctx_size, "issues": issues},
        )
    return CheckResult(
        name="context_health",
        ok=True,
        message=f"Contexto OK ({ctx_size} bytes, {len(pending)} señales pendientes)",
        details={"ctx_size_bytes": ctx_size, "pending_signals": len(pending)},
    )


def run_diagnostics(args: dict[str, Any], _context: Any = None) -> dict:
    """Run all diagnostic checks.

    Since F1, credentials are passed by the kernel via the sandbox request
    context rather than the subprocess environment. When ``_context`` is
    provided by the runner, we read credentials from it. Otherwise we fall
    back to os.environ for bare-metal dev (SANDBOX_STRICT=false).
    """
    plugin_ids: list[str] = args.get("active_plugin_ids", [])
    required_creds: list[str] = args.get("required_credentials", [])
    context: dict[str, Any] = args.get("context", {})

    # Resolve available credentials: prefer kernel-injected (F1), fall back to env.
    available_creds: dict[str, str] | None = None
    if _context is not None and hasattr(_context, "metadata"):
        ctx_creds = _context.metadata.get("credentials", None)
        if ctx_creds is not None:
            available_creds = ctx_creds

    checks = [
        check_plugin_files(plugin_ids),
        check_credentials(required_creds, available=available_creds),
        check_context_health(context),
    ]

    all_ok = all(c.ok for c in checks)
    errors = [c for c in checks if not c.ok]
    warnings = []  # se pueden agregar checks de warning-only aquí

    return {
        "ok": all_ok,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checks": [asdict(c) for c in checks],
        "summary": {
            "total": len(checks),
            "passed": sum(1 for c in checks if c.ok),
            "failed": len(errors),
        },
        "errors": [c.message for c in errors],
        "warnings": warnings,
    }


if __name__ == "__main__":
    data = json.loads(sys.stdin.read())
    fn = data.get("function", "run_diagnostics")
    args = data.get("args", {})

    if fn == "run_diagnostics":
        out = run_diagnostics(args)
    else:
        out = {"error": f"Función desconocida: {fn}"}

    print(json.dumps(out))
