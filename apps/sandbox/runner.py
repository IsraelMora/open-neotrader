#!/usr/bin/env python3
"""
NeuroTrader Sandbox Runner.
Lee un JSON de stdin, ejecuta el comando, escribe JSON a stdout.
Sin acceso a red (--network=none en Docker / bubblewrap en nativo).

Protocolo:
  request:  {"cmd": "<comando>", ...campos según cmd}
  response: {"ok": true, "result": <data>}
          | {"ok": false, "error": "<mensaje>"}

Comandos:
  list_plugins                                → lista plugins instalados
  get_skills                                  → skills de plugins activos
  get_symbols                                 → símbolos de universe_providers activos
  call_plugin  {plugin_id, function, args, context}   → ejecuta función de plugin
  run_cycle    {active_plugin_ids, context}   → ciclo completo del agente
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tomllib
import traceback
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Sandbox resource limits — applied inside main() before any plugin code runs
# ---------------------------------------------------------------------------
def _apply_resource_limits() -> None:
    """
    Apply OS-level resource limits for the sandbox process.

    Called as the first thing in main() so that:
      - a real sandbox invocation (python3 runner.py → __main__ → main()) still
        enforces all limits before any plugin module is loaded;
      - importing runner (e.g. in tests) does NOT cap the importing process.
    """
    try:
        import resource as _resource

        # CPU time en segundos (RLIMIT_CPU). Default: 60s. Override via SANDBOX_CPU_SECONDS.
        _cpu_seconds = int(os.environ.get("SANDBOX_CPU_SECONDS", "60"))
        _resource.setrlimit(_resource.RLIMIT_CPU, (_cpu_seconds, _cpu_seconds))

        # Memoria virtual en bytes (RLIMIT_AS). Default: 512 MB. Override via SANDBOX_MEM_MB.
        _mem_mb = int(os.environ.get("SANDBOX_MEM_MB", "512"))
        _mem_bytes = _mem_mb * 1024 * 1024
        _resource.setrlimit(_resource.RLIMIT_AS, (_mem_bytes, _mem_bytes))

        # Número de archivos abiertos (RLIMIT_NOFILE). Default: 64.
        _resource.setrlimit(_resource.RLIMIT_NOFILE, (64, 64))

        # Número de procesos hijo (RLIMIT_NPROC). Default: 64. Override via SANDBOX_MAX_PROCS.
        # Uses getattr so only NPROC is skipped on platforms that don't support it (e.g. some containers).
        _nproc = getattr(_resource, "RLIMIT_NPROC", None)
        if _nproc is None:
            print("[sandbox] RLIMIT_NPROC not available on this platform", file=sys.stderr)
        else:
            _max_procs = int(os.environ.get("SANDBOX_MAX_PROCS", "64"))
            _resource.setrlimit(_nproc, (_max_procs, _max_procs))

    except (ImportError, ValueError, OSError):
        # El módulo resource no está disponible en Windows o en algunos contenedores
        # No es un error fatal — el sandbox sigue funcionando sin límites del OS
        pass

# Import SDK Context so we can pass proper objects to plugin functions
try:
    from neurotrader_sdk import Context as _SdkContext
except ImportError:
    # Fallback when SDK isn't installed (CI / bare runner)
    class _SdkContext:  # type: ignore[no-redef]
        def __init__(self, **kw: Any):
            for k, v in kw.items():
                setattr(self, k, v)


PLUGINS_DIR = Path(os.environ.get("NEUROTRADER_PLUGINS_DIR", "/opt/neurotrader/plugins"))


# ---------------------------------------------------------------------------
# Isolation — applied after resource limits and before any plugin load
# ---------------------------------------------------------------------------
try:
    import isolation as _isolation
except ImportError:
    _isolation = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_semver(v: str) -> tuple[int, int, int] | None:
    """Parse a semver string 'X.Y.Z' into a tuple. Returns None if not parseable."""
    import re
    m = re.match(r'^(\d+)\.(\d+)\.(\d+)$', v)
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def _semver_gte(installed: str, required: str) -> bool:
    """
    Return True if installed >= required (semver comparison).
    If either string is not parseable, return True (don't block — soft-check contract).
    """
    a, b = _parse_semver(installed), _parse_semver(required)
    if a is None or b is None:
        return True
    return a >= b


def _sdk_version_warning(m: dict) -> str | None:
    """
    Check if the installed neurotrader_sdk satisfies the plugin's min_sdk_version.

    Returns a warning string if installed SDK < min_sdk_version, None otherwise.
    Never raises — exceptions (ImportError, AttributeError, any other) are caught silently.
    This is a SOFT-CHECK: it NEVER blocks plugin execution.
    """
    try:
        req = m.get("plugin", {}).get("min_sdk_version")
        if not req:
            return None
        try:
            from neurotrader_sdk import __version__ as sdk_ver
        except (ImportError, AttributeError):
            return None
        if _semver_gte(sdk_ver, req):
            return None
        return (
            f"[sandbox] plugin requires SDK >= {req} but installed SDK is {sdk_ver}; "
            "running anyway (soft-check)"
        )
    except Exception:
        return None


def resolve_permitted_function(
    declared_keys: set[str],
    plugin_id: str,
    requested: str,
) -> str:
    """
    Determine whether `requested` is a permitted function for `plugin_id`.

    Resolution rules (in order):
    1. Exact full-key match: `requested` == `f"{plugin_id}.{fn}"` for some
       declared key → permitted; returns the bare function name.
    2. Exact full-key match on `requested` itself (caller already sent the
       full qualified key, e.g. "my-plugin.analyze") → permitted if the key
       is in declared_keys; returns the last segment.
    3. Back-compat bare-name: `requested` has no dot AND exactly ONE declared
       key ends with `.{requested}` AND that key belongs to `plugin_id`
       → permitted (with implicit deprecation note); returns `requested`.
    4. Ambiguous bare-name: bare `requested` matches >1 declared key → DENY.
    5. No match → DENY.

    Raises PermissionError on denial.
    """
    # Rule 2: requested is already the full qualified key
    full_qualified = f"{plugin_id}.{requested}"

    if full_qualified in declared_keys:
        # Full key constructed from plugin_id + requested matches
        return requested

    if requested in declared_keys:
        # Caller sent the full key directly (e.g. "my-plugin.analyze")
        return requested.split(".")[-1]

    # Rules 3 & 4: bare-name back-compat (no dot in requested).
    # Only keys belonging to THIS plugin_id are eligible for back-compat.
    if "." not in requested:
        matches = [
            k for k in declared_keys
            if k.endswith(f".{requested}") and k.startswith(f"{plugin_id}.")
        ]
        if len(matches) == 1:
            # Unambiguous — allow but caller should migrate to full key
            return requested
        elif len(matches) > 1:
            raise PermissionError(
                f"[sandbox] Function '{requested}' is ambiguous — matches "
                f"{len(matches)} declared keys for plugin '{plugin_id}'. "
                "Send the fully-qualified key (e.g. 'plugin-id.function_name')."
            )

    raise PermissionError(
        f"[sandbox] Function '{requested}' (plugin '{plugin_id}') is not declared "
        "in manifest.skills.keys — execution denied."
    )


def _read_manifest(plugin_id: str) -> dict[str, Any]:
    path = PLUGINS_DIR / plugin_id / "manifest.toml"
    if not path.exists():
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


def _load_module(plugin_id: str):
    plugin_path = PLUGINS_DIR / plugin_id
    plugin_file = plugin_path / "plugin.py"
    if not plugin_file.exists():
        raise FileNotFoundError(f"plugin.py not found in: {plugin_id}")

    spec = importlib.util.spec_from_file_location(f"_nt_{plugin_id}", plugin_file)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot create spec for: {plugin_id}")
    mod = importlib.util.module_from_spec(spec)
    plugin_str = str(plugin_path)
    if plugin_str not in sys.path:
        sys.path.insert(0, plugin_str)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod


def _plugin_info(plugin_id: str, active_ids: set[str]) -> dict[str, Any] | None:
    m = _read_manifest(plugin_id)
    if not m:
        return None
    pid = m.get("plugin", {}).get("id", plugin_id)
    return {
        "id": pid,
        "name": m.get("plugin", {}).get("name", plugin_id),
        "version": m.get("plugin", {}).get("version", "0.0.0"),
        "type": m.get("plugin", {}).get("type", "skill"),
        "description": m.get("plugin", {}).get("description", ""),
        "author": m.get("plugin", {}).get("author", ""),
        "skills": m.get("skills", {}).get("keys", []),
        "active": pid in active_ids,
    }


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------


def cmd_list_plugins(req: dict) -> list:
    active_ids: set[str] = set(req.get("active_ids", []))
    if not PLUGINS_DIR.exists():
        return []
    result = []
    for entry in sorted(PLUGINS_DIR.iterdir()):
        if entry.is_dir():
            info = _plugin_info(entry.name, active_ids)
            if info:
                result.append(info)
    return result


def cmd_get_skills(req: dict) -> list:
    active_ids: set[str] = set(req.get("active_ids", []))
    skills: list[dict] = []
    if not PLUGINS_DIR.exists():
        return skills
    for entry in sorted(PLUGINS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        m = _read_manifest(entry.name)
        pid = m.get("plugin", {}).get("id", entry.name)
        if pid not in active_ids:
            continue
        for key in m.get("skills", {}).get("keys", []):
            skills.append({"plugin_id": pid, "key": key})
    return skills


def cmd_get_symbols(req: dict) -> list:
    active_ids: set[str] = set(req.get("active_ids", []))
    symbols: list[str] = []
    if not PLUGINS_DIR.exists():
        return symbols
    for entry in sorted(PLUGINS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        m = _read_manifest(entry.name)
        pid = m.get("plugin", {}).get("id", entry.name)
        if pid not in active_ids:
            continue
        if m.get("plugin", {}).get("type") != "universe_provider":
            continue
        try:
            mod = _load_module(entry.name)
            if hasattr(mod, "get_universe"):
                result = mod.get_universe()
                if isinstance(result, list):
                    symbols.extend(result)
        except Exception:
            pass
    return list(dict.fromkeys(symbols))


def cmd_call_plugin(req: dict) -> Any:
    plugin_id: str = req["plugin_id"]
    fn_name: str = req["function"]
    args: dict = req.get("args", {})
    context: dict = req.get("context", {})

    plugin_dir = PLUGINS_DIR / plugin_id
    if not plugin_dir.is_dir():
        raise FileNotFoundError(f"Plugin not found: {plugin_id}")

    m = _read_manifest(plugin_id)
    allowed_keys: set[str] = set(m.get("skills", {}).get("keys", []))
    # Full-key exact matching (closes suffix-collision namespace bug).
    # resolve_permitted_function raises PermissionError on denial.
    fn_name = resolve_permitted_function(allowed_keys, plugin_id, fn_name)

    mod = _load_module(plugin_id)
    fn = getattr(mod, fn_name, None)
    if fn is None:
        raise AttributeError(f"Function '{fn_name}' not found in plugin '{plugin_id}'")
    ctx = _SdkContext(plugin_id=plugin_id, operator=context.get("operator", ""), metadata=context)
    return fn(**args, _context=ctx)


def cmd_run_hook(req: dict) -> dict:
    """
    Ejecuta un hook de ciclo de vida de un plugin.

    Request:
      { "cmd": "run_hook", "plugin_id": "...", "hook": "on_cycle|on_activate|on_deactivate",
        "context": { universe, config, portfolio, provider_tools, ... } }

    El hook es un script Python en hooks/<hook_name>.py que exporta
    una función on_cycle(ctx) | on_activate(ctx) | on_deactivate(ctx).
    """
    plugin_id: str = req["plugin_id"]
    hook_name: str = req.get("hook", "on_cycle")
    context: dict = req.get("context", {})

    if hook_name not in ("on_cycle", "on_activate", "on_deactivate"):
        raise ValueError(
            f"Hook desconocido: {hook_name}. Válidos: on_cycle, on_activate, on_deactivate"
        )

    plugin_dir = PLUGINS_DIR / plugin_id
    if not plugin_dir.is_dir():
        raise FileNotFoundError(f"Plugin no encontrado: {plugin_id}")

    m = _read_manifest(plugin_id)

    # Soft SDK version check — never blocks, never raises
    _w = _sdk_version_warning(m)

    hooks_cfg: dict = m.get("hooks", {})
    hook_file_rel: str = hooks_cfg.get(hook_name, f"hooks/{hook_name}.py")
    hook_path = plugin_dir / hook_file_rel

    if not hook_path.exists():
        # No es un error tener hook ausente; simplemente no hay nada que ejecutar
        r: dict = {
            "signals": [],
            "logs": [{"level": "debug", "msg": f"Sin hook {hook_name} en {plugin_id}"}],
        }
        if _w:
            r.setdefault("warnings", []).append(_w)
        return r

    # Cargar dinámicamente el módulo hook
    spec = importlib.util.spec_from_file_location(f"_nt_{plugin_id}_{hook_name}", hook_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"No se puede cargar hook: {hook_path}")

    mod = importlib.util.module_from_spec(spec)
    plugin_str = str(plugin_dir)
    if plugin_str not in sys.path:
        sys.path.insert(0, plugin_str)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]

    fn = getattr(mod, hook_name, None)
    if fn is None:
        raise AttributeError(f"Función '{hook_name}' no encontrada en {hook_path}")

    # Enriquecer el contexto con config del manifest.
    # [config] entries may be raw primitives (e.g. fail_on_missing_credentials = false)
    # or ConfigFieldSpec dicts ({default: ..., type: ...}). Handle both shapes.
    config_defaults = {
        field: (spec_data.get("default") if isinstance(spec_data, dict) else spec_data)
        for field, spec_data in m.get("config", {}).items()
    }
    effective_config = {**config_defaults, **context.get("config", {})}
    ctx = {**context, "config": effective_config}

    result = fn(ctx)
    if not isinstance(result, dict):
        result = {"signals": [], "logs": []}
    if _w:
        result.setdefault("warnings", []).append(_w)
    return result


def cmd_emit_signal(req: dict) -> dict:
    """
    Registra una señal emitida por un plugin.
    Actualmente solo valida el formato y la retorna para que el llamador la persista.

    Request: { "cmd": "emit_signal", "plugin_id": "...", "signal": { type, symbol, ... } }
    """
    plugin_id = req.get("plugin_id", "unknown")
    signal: dict = req.get("signal", {})

    required_fields = {"type", "symbol", "action"}
    missing = required_fields - signal.keys()
    if missing:
        raise ValueError(f"Señal inválida: faltan campos {missing}")

    return {
        "accepted": True,
        "signal": {**signal, "_plugin": plugin_id},
    }


def _classify(exc: BaseException) -> tuple[str, str]:
    """
    Classify a plugin exception as 'inconclusive' or 'failed'.

    Order:
    1. TYPE-first: ImportError / SyntaxError / AttributeError / TypeError / NameError
       → always 'failed' (structural defect, regardless of message).
    2. Message-heuristic: KeyError / LookupError / ValueError whose message
       contains credential/data substrings → 'inconclusive'.
    3. Generic KeyError (no matched message) → 'inconclusive'
       (credential key absence is the most common KeyError in plugins).
    4. Default → 'failed'.

    Returns (status, detail) where status is 'inconclusive' | 'failed'.
    """
    detail = f"{type(exc).__name__}: {exc}"

    # --- TYPE-first gate (structural defects) --------------------------------
    if isinstance(exc, (ImportError, SyntaxError, AttributeError, TypeError, NameError)):
        return "failed", detail

    # --- Message-heuristic for credential/data-dependent exceptions ----------
    _INCONCLUSIVE_SUBSTRINGS = (
        "credential",
        "api key",
        "api_key",
        "token",
        "secret",
        "unauthorized",
        "401",
        "empty",
        "no data",
        "not found",
        "missing",
    )
    msg_lower = str(exc).lower()
    if isinstance(exc, (KeyError, LookupError, ValueError)):
        if any(s in msg_lower for s in _INCONCLUSIVE_SUBSTRINGS):
            return "inconclusive", detail
        # Generic KeyError with no matched message → inconclusive
        # (absent credential key is the dominant cause in plugins)
        if isinstance(exc, KeyError):
            return "inconclusive", detail
        # Other LookupError / ValueError without matching substrings → failed
        return "failed", detail

    # --- Generic message heuristic for any exception type -------------------
    if any(s in msg_lower for s in _INCONCLUSIVE_SUBSTRINGS):
        return "inconclusive", detail

    # --- Default: structural failure ----------------------------------------
    return "failed", detail


def cmd_smoke_test(req: dict) -> dict:
    """
    Execute a pre-activation smoke test for a plugin.

    Request: {"cmd": "smoke_test", "plugin_id": "<id>"}
    Response: {"ok": True, "result": "passed"|"inconclusive"|"failed",
               "checks": [{"name": str, "status": str, "detail": str}]}

    Runs three check categories:
    1. manifest-parse: _read_manifest must succeed.
    2. on_activate: if hook file exists, load + call fn(ctx) with empty typed ctx.
    3. skills: for each key in manifest.skills.keys, resolve + call fn(signal, _context).

    Aggregate: failed > inconclusive > passed.
    Only FileNotFoundError propagates (missing plugin dir); all plugin code
    exceptions are caught and classified.

    EXECUTES plugin code intentionally — safe under SANDBOX_STRICT isolation.
    """
    plugin_id: str = req["plugin_id"]
    plugin_dir = PLUGINS_DIR / plugin_id

    if not plugin_dir.is_dir():
        raise FileNotFoundError(f"Plugin not found: {plugin_id}")

    checks: list[dict] = []

    # --- 1. Manifest check ---------------------------------------------------
    try:
        m = _read_manifest(plugin_id)
        if not m:
            checks.append({
                "name": "manifest",
                "status": "failed",
                "detail": "manifest.toml missing or empty",
            })
            m = {}
        else:
            checks.append({"name": "manifest", "status": "passed", "detail": "manifest.toml parseable"})
    except Exception as exc:
        checks.append({"name": "manifest", "status": "failed", "detail": str(exc)})
        m = {}

    # --- Shared config defaults (used by both hook and skill ctx below) --------
    config_defaults: dict = {}
    if m:
        for field, spec_data in m.get("config", {}).items():
            config_defaults[field] = (
                spec_data.get("default") if isinstance(spec_data, dict) else spec_data
            )

    # --- 2. on_activate check -----------------------------------------------
    hooks_cfg: dict = m.get("hooks", {}) if m else {}
    hook_file_rel: str = hooks_cfg.get("on_activate", "hooks/on_activate.py")
    hook_path = plugin_dir / hook_file_rel

    if not hook_path.exists():
        checks.append({
            "name": "on_activate",
            "status": "passed",
            "detail": "no on_activate hook (absence is fine)",
        })
    else:
        try:
            import importlib.util as _ilu
            hook_spec = _ilu.spec_from_file_location(
                f"_nt_smoke_{plugin_id}_on_activate", hook_path
            )
            if hook_spec is None or hook_spec.loader is None:
                raise ImportError(f"Cannot load hook spec: {hook_path}")
            hook_mod = _ilu.module_from_spec(hook_spec)
            plugin_str = str(plugin_dir)
            if plugin_str not in sys.path:
                sys.path.insert(0, plugin_str)
            hook_spec.loader.exec_module(hook_mod)  # type: ignore[attr-defined]
            fn = getattr(hook_mod, "on_activate", None)
            if fn is None:
                checks.append({
                    "name": "on_activate",
                    "status": "failed",
                    "detail": "on_activate function not found in hook file",
                })
            else:
                # Hooks receive a plain dict (mirrors cmd_run_hook: ctx = {**context, "config": ...})
                hook_ctx: dict = {"config": config_defaults}
                fn(hook_ctx)
                checks.append({"name": "on_activate", "status": "passed", "detail": "on_activate ran without error"})
        except Exception as exc:
            status, detail = _classify(exc)
            checks.append({"name": "on_activate", "status": status, "detail": detail})

    # --- 3. Skills checks ---------------------------------------------------
    declared_keys: list[str] = m.get("skills", {}).get("keys", []) if m else []

    # Load module once (avoid double side-effects)
    mod = None
    if declared_keys:
        try:
            mod = _load_module(plugin_id)
        except Exception as exc:
            # Module load failure → all skill checks fail
            status, detail = _classify(exc)
            for key in declared_keys:
                checks.append({"name": key, "status": status, "detail": f"module load error: {detail}"})
            declared_keys = []  # skip per-skill loop below

    for key in declared_keys:
        try:
            fn_name = resolve_permitted_function(set(declared_keys), plugin_id, key)
        except PermissionError as exc:
            checks.append({"name": key, "status": "failed", "detail": str(exc)})
            continue

        fn = getattr(mod, fn_name, None) if mod is not None else None
        if fn is None:
            checks.append({
                "name": key,
                "status": "failed",
                "detail": f"declared skill fn '{fn_name}' not defined in plugin.py",
            })
            continue

        try:
            # Skill fns receive a Context object (mirrors cmd_run_cycle / cmd_call_plugin:
            # ctx = _SdkContext(plugin_id=..., operator=..., metadata=context))
            skill_ctx = _SdkContext(
                plugin_id=plugin_id,
                operator="",
                metadata={"config": config_defaults},
            )
            fn(signal={}, _context=skill_ctx)
            checks.append({"name": key, "status": "passed", "detail": "skill fn called without error"})
        except Exception as exc:
            status, detail = _classify(exc)
            checks.append({"name": key, "status": status, "detail": detail})

    # --- Aggregate worst-of --------------------------------------------------
    statuses = {c["status"] for c in checks}
    if "failed" in statuses:
        overall = "failed"
    elif "inconclusive" in statuses:
        overall = "inconclusive"
    else:
        overall = "passed"

    return {"ok": True, "result": overall, "checks": checks}


def cmd_analyze_plugin(req: dict) -> dict:
    """
    Run static AST analysis on a plugin directory.

    Request: {"cmd": "analyze_plugin", "plugin_id": "<id>"}
    Response: scan_result dict — {ok: True, findings: [...], summary: {...}}

    IMPORTANT: NEVER calls _load_module or executes plugin code.
    Uses analyzer.analyze_plugin() which is AST-only (pure file read + ast.parse).

    Runs safely under SANDBOX_STRICT=true:
      - Only reads files under PLUGINS_DIR (allowed root for the open() guard)
      - Only imports stdlib `ast` (not in BLOCKED_MODULES)
    """
    import analyzer as _analyzer  # local import mirrors isolation/other helpers

    plugin_id: str = req["plugin_id"]
    plugin_dir = PLUGINS_DIR / plugin_id

    if not plugin_dir.is_dir():
        raise FileNotFoundError(f"Plugin not found: {plugin_id}")

    manifest = _read_manifest(plugin_id)
    return _analyzer.analyze_plugin(plugin_dir, manifest)


def cmd_run_cycle(req: dict) -> dict:
    active_ids: set[str] = set(req.get("active_ids", []))
    context: dict = req.get("context", {})

    if not PLUGINS_DIR.exists():
        return {"universe": [], "signals": [], "errors": []}

    plugins_by_id: dict[str, dict] = {}
    for entry in sorted(PLUGINS_DIR.iterdir()):
        if not entry.is_dir():
            continue
        m = _read_manifest(entry.name)
        if not m:
            continue
        pid = m.get("plugin", {}).get("id", entry.name)
        plugins_by_id[pid] = {
            "dir": entry.name,
            "manifest": m,
            "type": m.get("plugin", {}).get("type", "skill"),
        }

    results: dict[str, Any] = {"universe": [], "signals": [], "errors": []}

    # Soft SDK version check for each active plugin — never blocks, never raises
    for pid, info in plugins_by_id.items():
        if pid not in active_ids:
            continue
        _w = _sdk_version_warning(info["manifest"])
        if _w:
            results.setdefault("warnings", []).append(_w)

    # 1. Collect universe
    for pid, info in plugins_by_id.items():
        if pid not in active_ids or info["type"] != "universe_provider":
            continue
        try:
            mod = _load_module(info["dir"])
            if hasattr(mod, "get_universe"):
                syms = mod.get_universe()
                if isinstance(syms, list):
                    results["universe"].extend(syms)
        except Exception as e:
            results["errors"].append({"plugin": pid, "stage": "universe", "error": str(e)})

    results["universe"] = list(dict.fromkeys(results["universe"]))

    # 2. Run disciplines
    for pid, info in plugins_by_id.items():
        if pid not in active_ids or info["type"] != "discipline":
            continue
        try:
            mod = _load_module(info["dir"])
            fn_name = info["manifest"].get("discipline", {}).get("function", "run_discipline")
            fn = getattr(mod, fn_name, None)
            if fn is None:
                continue
            ctx = _SdkContext(plugin_id=pid, operator=context.get("operator", ""), metadata=context)
            signals = fn(universe=results["universe"], _context=ctx)
            if isinstance(signals, list):
                for sig in signals:
                    sig["_plugin"] = pid
                results["signals"].extend(signals)
        except Exception as e:
            results["errors"].append({"plugin": pid, "stage": "discipline", "error": str(e)})

    # 3. Enrich signals with skills
    skill_plugins = [
        (pid, info)
        for pid, info in plugins_by_id.items()
        if pid in active_ids and info["type"] == "skill"
    ]
    enriched = []
    for signal in results["signals"]:
        enriched_sig = dict(signal)
        for pid, info in skill_plugins:
            try:
                mod = _load_module(info["dir"])
                ctx = _SdkContext(
                    plugin_id=pid, operator=context.get("operator", ""), metadata=context
                )
                for key in info["manifest"].get("skills", {}).get("keys", []):
                    fn_name = key.split(".")[-1]
                    fn = getattr(mod, fn_name, None)
                    if fn is None:
                        continue
                    enriched_sig[key] = fn(signal=signal, _context=ctx)
            except Exception:
                pass
        enriched.append(enriched_sig)

    results["signals"] = enriched
    return results


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

COMMANDS = {
    "list_plugins": cmd_list_plugins,
    "get_skills": cmd_get_skills,
    "get_symbols": cmd_get_symbols,
    "call_plugin": cmd_call_plugin,
    "run_hook": cmd_run_hook,
    "emit_signal": cmd_emit_signal,
    "run_cycle": cmd_run_cycle,
    "analyze_plugin": cmd_analyze_plugin,
    "smoke_test": cmd_smoke_test,
}


def main() -> None:
    # Apply OS resource limits first — before any plugin code or isolation guards.
    _apply_resource_limits()

    # Apply in-process isolation guards AFTER resource limits and BEFORE any
    # plugin module is loaded.  Gated by SANDBOX_STRICT (default: true).
    if _isolation is not None:
        _strict = os.environ.get("SANDBOX_STRICT", "true").lower() != "false"
        _isolation.apply(strict=_strict, allowed_roots=[PLUGINS_DIR])

    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
        cmd = req.get("cmd", "call_plugin")  # backward-compat default
        handler = COMMANDS.get(cmd)
        if handler is None:
            response: dict = {"ok": False, "error": f"Unknown command: {cmd}"}
        else:
            result = handler(req)
            response = {"ok": True, "result": result}
    except json.JSONDecodeError as e:
        response = {"ok": False, "error": f"Invalid JSON: {e}"}
    except (PermissionError, FileNotFoundError, AttributeError) as e:
        response = {"ok": False, "error": str(e)}
    except Exception:
        response = {"ok": False, "error": traceback.format_exc(limit=5)}

    print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
