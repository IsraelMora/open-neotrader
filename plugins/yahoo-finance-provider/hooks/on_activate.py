"""
Yahoo Finance Provider — validación de activación.
Sin API key, solo verifica la configuración básica.
"""


def on_activate(ctx):
    cfg = ctx.get("config", {})

    warnings = []

    if cfg.get("fallback_only", True):
        warnings.append(
            "Configurado como fallback_only=true: solo se usará cuando no haya "
            "otros providers activos. Para usarlo como primario, pon fallback_only=false."
        )

    return {
        "ok": True,
        "message": (
            "Yahoo Finance activado (API pública no oficial, sin API key). "
            "LIMITACIONES: datos históricos diarios + datos en tiempo real diferidos ~15 min; "
            "sin soporte de órdenes; la API puede cambiar sin aviso."
        ),
        "warnings": warnings,
    }
