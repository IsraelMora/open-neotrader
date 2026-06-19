# NeuroTrader Plugin Protocol (NTPP v1)

## Estructura de un plugin

```
plugins/mi-plugin/
├── manifest.toml          # Declaración del plugin
├── plugin.py              # Código Python (punto de entrada)
├── requirements.txt       # Dependencias Python (resueltas al instalar)
└── README.md              # Documentación
```

## manifest.toml — schema completo

```toml
[plugin]
id = "ensemble-signals"            # slug único, kebab-case
name = "Señales Ensemble"          # nombre legible
type = "strategy"                  # skill | universe | discipline | data-provider | strategy | stack
version = "1.0.0"                  # semver
author = "alex@example.com"
description = "Motor de señales de tendencia y momentum."
neurotrader_sdk = ">=1.0.0"        # versión mínima del SDK

[permissions]
network = false                    # siempre false en sandbox; declarativo para auditoría
filesystem = "data"                # "data" (solo /data/plugin-id/) | "none"
max_memory_mb = 512
max_cpu_seconds = 30

[tools]
# Tools que el LLM puede invocar (via tool call)
[[tools.functions]]
name = "propose_allocation"
description = "Propone una asignación de cartera basada en las señales actuales."
parameters = { portfolio_value = "float", symbols = "list[str]" }
returns = "dict[str, float]"       # { symbol: exposure_fraction }

[[tools.functions]]
name = "explain_signal"
description = "Explica en texto por qué se activa una señal para un símbolo."
parameters = { symbol = "str", signal_name = "str" }
returns = "str"

[dependencies]                     # solo para type = "stack"
plugins = []

[verification]
status = "unverified"              # unverified | pending | verified | rejected
verified_at = ""
verified_by = ""
```

## plugin.py — estructura base

```python
from neurotrader_sdk import Plugin, tool, Context

class EnsembleSignals(Plugin):
    
    def on_load(self) -> None:
        """Llamado al cargar el plugin (inicialización)."""
        pass
    
    def on_unload(self) -> None:
        """Llamado al descargar el plugin (cleanup)."""
        pass
    
    @tool
    def propose_allocation(
        self,
        ctx: Context,
        portfolio_value: float,
        symbols: list[str]
    ) -> dict[str, float]:
        """El LLM puede llamar a esta función. ctx es read-only."""
        # ctx.portfolio, ctx.config, ctx.market_snapshot
        # El sandbox bloquea: requests, socket, subprocess, open (fuera de /data)
        signals = self._compute(ctx.market_snapshot, symbols)
        return signals
    
    @tool
    def explain_signal(self, ctx: Context, symbol: str, signal_name: str) -> str:
        return f"La señal {signal_name} para {symbol} se activa porque..."
    
    def _compute(self, snapshot, symbols):
        # lógica privada — el LLM no puede llamar a _compute directamente
        ...
```

## Contexto enviado al plugin (read-only)

```python
@dataclass(frozen=True)
class Context:
    portfolio: PortfolioSnapshot      # valor, posiciones, cash
    config: PluginConfig              # configuración del plugin (del panel)
    market_snapshot: MarketSnapshot   # último snapshot del mercado (precios, etc.)
    agent_run_id: str                 # ID del ciclo actual

@dataclass(frozen=True)
class MarketSnapshot:
    timestamp: str
    symbols: dict[str, SymbolData]   # symbol → datos
    
@dataclass(frozen=True)
class SymbolData:
    # NO se pasan series crudas al LLM — solo resúmenes
    last_price: float
    change_1d: float
    volatility_20d: float
    regime: str                       # "trending" | "ranging" | "volatile"
```

## Restricciones del sandbox

El sandbox aplica restricciones en dos niveles:

### Límites de recursos del OS (siempre activos)

Aplicados al iniciar `runner.py` mediante el módulo `resource`:

- **CPU**: configurable via `SANDBOX_CPU_SECONDS` (default: 60 s)
- **Memoria virtual**: configurable via `SANDBOX_MEM_MB` (default: 512 MB)
- **File descriptors**: máximo 64

### Guards en-proceso Python (F1 PR3 — gated por `SANDBOX_STRICT`)

> **Estado actual (PR1)**: los guards en-proceso Python son **declarativos** — el módulo
> de aislamiento no está implementado todavía. Se añadirá en F1 PR3. Los límites de
> recursos del OS (CPU, memoria, file descriptors) son los únicos controles activos hoy.

Cuando el módulo de aislamiento esté disponible (F1 PR3), funcionará así:

Bajo `SANDBOX_STRICT=true` (default de producción), `runner.py` activará guards antes de
cargar cualquier código de plugin:

- **Import guard**: bloqueará en-proceso los módulos de red y sistema más peligrosos
  (`socket`, `ssl`, `requests`, `urllib`, `http`, `subprocess`, `multiprocessing`, `ctypes`, `cffi`,
  entre otros). Si un plugin hace `import socket`, se lanzará `ImportError`.

- **Open guard**: reemplazará `builtins.open` con una versión restringida a rutas bajo
  `NEUROTRADER_PLUGINS_DIR`. Cualquier intento de abrir rutas del host lanzará `PermissionError`.

Bajo `SANDBOX_STRICT=false` (modo dev en bare-metal), los guards se desactivarán y
`runner.py` emitirá un aviso estructurado a stderr indicando exactamente qué está relajado.

**Limitación importante**: estos guards son Python en-proceso. No son equivalentes al
aislamiento a nivel OS. Un plugin con código nativo (`.so`) podría eludirlos. El aislamiento
OS completo (Docker, seccomp, namespaces) es una medida de despliegue, no de runner:

### Aislamiento OS (F5 / deployment-dependent — no garantizado en dev bare-metal)

Las siguientes medidas se aplican **solo en despliegue con Docker / contenedor configurado**
y NO están garantizadas cuando se ejecuta el sandbox en bare-metal de desarrollo:

- `--network=none`: sin acceso a red a nivel OS
- Filesystem montado read-only excepto el volumen de datos del plugin
- `--cap-drop=ALL`: sin capabilities de sistema
- Seccomp profile que bloquea syscalls peligrosas (ptrace, mount, etc.)

## Plugin Stack

Un stack es un plugin de tipo `stack` que agrupa otros:

```toml
[plugin]
id = "starter-pack-equities"
type = "stack"
name = "Starter Pack — Equities"

[stack]
plugins = [
  "ensemble-signals@>=1.0.0",
  "universo-base@>=1.0.0",
  "disciplina-dsr@>=1.0.0",
  "data-providers@>=2.0.0",
]
```

Al instalar un stack, NestJS:
1. Resuelve y descarga cada plugin en orden
2. Instala y activa cada uno
3. El stack queda como metadato (para saber que viene en grupo)
4. Si un plugin del stack ya está instalado, se omite (idempotente)

Un stack puede mezclar autores distintos. La verificación del stack es independiente de la verificación de cada plugin individual (un stack verificado = todos sus plugins fueron revisados juntos).
