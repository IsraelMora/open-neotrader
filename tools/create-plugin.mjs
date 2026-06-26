#!/usr/bin/env node
/**
 * OpenNeoTrader Plugin Scaffold
 * Uso: node tools/create-plugin.mjs <nombre> [--type skill|provider|discipline|universe|stack|extra]
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { parseArgs } from 'util';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    type:   { type: 'string', short: 't', default: 'skill' },
    author: { type: 'string', short: 'a', default: 'community' },
    help:   { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

const VALID_TYPES = ['skill', 'provider', 'discipline', 'universe', 'stack', 'extra'];

if (values.help || positionals.length === 0) {
  console.log(`
OpenNeoTrader Plugin Scaffold
───────────────────────────
Uso: node tools/create-plugin.mjs <nombre> [opciones]

Opciones:
  -t, --type    Tipo de plugin: ${VALID_TYPES.join(' | ')}  (default: skill)
  -a, --author  Nombre del autor                            (default: community)
  -h, --help    Muestra esta ayuda

Ejemplos:
  node tools/create-plugin.mjs rsi-analysis
  node tools/create-plugin.mjs alpaca-broker --type provider --author tu-usuario
  node tools/create-plugin.mjs my-universe   --type universe
`);
  process.exit(0);
}

const name = positionals[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
const type = values.type;
const author = values.author;

if (!VALID_TYPES.includes(type)) {
  console.error(`Error: tipo inválido '${type}'. Válidos: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

const pluginsDir = resolve(process.cwd(), 'plugins');
const pluginDir = join(pluginsDir, name);

if (existsSync(pluginDir)) {
  console.error(`Error: el directorio '${pluginDir}' ya existe`);
  process.exit(1);
}

// ── Templates por tipo ─────────────────────────────────────────────────────────

const MANIFEST = `[plugin]
id          = "${name}"
name        = "${titleCase(name)}"
version     = "0.1.0"
type        = "${type}"
description = "Describe qué hace este plugin y cuándo se usa."
author      = "${author}"
license     = "MIT"
# repository = "https://github.com/${author}/${name}"
# min_platform_version = "1.0.0"
${type === 'provider' || type === 'discipline' ? `
# Credenciales que el usuario debe configurar (aparecen en la UI automáticamente)
# [credentials]
# MY_API_KEY = { label = "API Key", required = true, group = "${name}" }
# MY_SECRET  = { label = "API Secret", required = true, group = "${name}" }
` : ''}${type !== 'stack' ? `
# Opciones configurables desde la UI (generan formulario automáticamente)
# [config]
# [config.mode]
# type    = "string"
# enum    = ["paper", "live"]
# default = "paper"
# label   = "Modo de operación"
${type === 'skill' || type === 'discipline' ? `
# Frecuencia configurable desde la UI del plugin
# Cuando el usuario cambia estos valores, el scheduler lo recoge automáticamente
# [config.scheduler_interval_ms]
# type    = "number"
# default = 86400000
# min     = 60000
# max     = 604800000
# label   = "Intervalo de ciclo (ms)"
# description = "Cada cuántos ms ejecutar este plugin. 86400000 = diario."
#
# [config.scheduler_timeframe]
# type    = "string"
# enum    = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1mo"]
# default = "1d"
# label   = "Timeframe de datos"
# description = "Temporalidad de las velas que necesita este plugin."
` : ''}` : ''}${type === 'skill' || type === 'provider' || type === 'discipline' ? `
# Hooks de ciclo de vida (ficheros Python a ejecutar)
# [hooks]
# on_activate   = "hooks/setup.py"
# on_deactivate = "hooks/teardown.py"
# on_cycle      = "hooks/cycle.py"
` : ''}${type === 'stack' ? `
[stack]
requires = [
  # "otro-plugin@^1.0.0",
]
` : ''}
# Permisos del sandbox (false por defecto = más seguro)
[permissions]
network     = false
emit_events = true
${type === 'skill' || type === 'discipline' ? `
# Frecuencia de ejecución declarada para el scheduler automático
# mode: "polling" (el platform lo llama) | "reactive" (el plugin emite eventos) | "none" (sin ciclos)
# timeframe: "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1mo"
[scheduler]
mode        = "polling"
timeframe   = "1d"
interval_ms = 86400000
` : ''}`;


const SKILL_MD = `---
name: ${titleCase(name)}
description: Describe qué hace este skill y cuándo el LLM debe usarlo. Sé específico — esta descripción siempre está cargada en el contexto.
---

# ${titleCase(name)}

## Cuándo usar este skill

Activa este skill cuando...

## Flujo de trabajo

1. Paso 1
2. Paso 2
3. Paso 3

## Parámetros y configuración

| Parámetro | Valor por defecto | Descripción |
|-----------|-------------------|-------------|
| param1    | valor1            | descripción |

## Recursos adicionales

- Lee \`REFERENCIA.md\` para la documentación completa de la API
- Ejecuta \`scripts/analizar.py\` para cálculos complejos

## Notas aprendidas

<!-- El LLM actualiza esta sección automáticamente con patrones detectados -->
`;

const TOOLS_JSON = JSON.stringify([
  {
    name: 'example_function',
    description: 'Describe qué hace esta función. El LLM usa esta descripción para decidir cuándo llamarla.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Símbolo del activo (ej. AAPL)' },
      },
      required: ['symbol'],
    },
  },
], null, 2);

const MAIN_PY = `"""
${titleCase(name)} plugin — ${type}

Punto de entrada principal del plugin.
La plataforma ejecuta este código en un sandbox Python sin acceso a internet.
"""
from neurotrader_sdk import PluginContext, register_tool


@register_tool
def example_function(ctx: PluginContext, symbol: str) -> dict:
    """
    Ejemplo de función expuesta al LLM.

    Args:
        ctx: Contexto de la plataforma (credenciales, config, logger)
        symbol: Símbolo del activo

    Returns:
        dict con el resultado
    """
    api_key = ctx.credential("MY_API_KEY")   # Lee de .env vía plataforma
    config = ctx.config                       # Config guardada por el usuario en la UI
    ctx.log.info(f"Procesando {symbol}")

    # Tu lógica aquí
    return {"symbol": symbol, "result": "ok"}
`;

const CYCLE_PY = `"""
Hook on_cycle — se ejecuta en cada ciclo del agente.

Úsalo para:
- Recolectar datos de mercado
- Calcular métricas
- Emitir señales a otros plugins
- Actualizar el estado del portfolio
"""
from neurotrader_sdk import CycleContext


def on_cycle(ctx: CycleContext) -> dict:
    """
    ctx.active_plugins  — lista de IDs de plugins activos
    ctx.config          — configuración del plugin
    ctx.emit_signal()   — emite una señal al bus de eventos
    ctx.log             — logger
    ctx.credentials     — acceso a credenciales
    """
    ctx.log.info("Ciclo iniciado")

    # Tu lógica aquí

    return {"ok": True}
`;

const UNIVERSE_PY = `"""
Plugin de universo de activos.
Define qué símbolos están disponibles para negociar.
"""

SYMBOLS = [
    # Añade tus símbolos aquí
    # {"symbol": "AAPL", "kind": "equity", "description": "Apple Inc."},
]

def get_symbols() -> list[dict]:
    return SYMBOLS
`;

const README = `# ${titleCase(name)}

Plugin para la plataforma [OpenNeoTrader](https://github.com/tu-org/neurotrader).

**Tipo:** \`${type}\`
**Autor:** ${author}

## Instalación

\`\`\`
# Desde la UI de OpenNeoTrader: Plugins → Instalar → pega la URL del repo
# O via API:
POST /api/plugins/install
{ "source": "https://github.com/${author}/${name}.git" }
\`\`\`

## Configuración

${type === 'provider' || type === 'discipline' ? `### Credenciales requeridas
Configúralas en **Panel → Credenciales**:
- \`MY_API_KEY\` — descripción
- \`MY_SECRET\` — descripción

` : ''}### Opciones
Configúralas en **Plugins → ${titleCase(name)} → Configuración**:

| Opción | Por defecto | Descripción |
|--------|-------------|-------------|
| mode   | paper       | Modo de operación |

## Desarrollo

\`\`\`bash
# Estructura del plugin
${name}/
├── manifest.toml   # Metadatos, credenciales, schema de config
├── SKILL.md        # Instrucciones para el LLM
├── tools.json      # Funciones llamables por el LLM
├── main.py         # Implementación Python
├── hooks/
│   ├── setup.py    # on_activate
│   ├── teardown.py # on_deactivate
│   └── cycle.py    # on_cycle
└── README.md
\`\`\`
`;

// ── Crear estructura de archivos ───────────────────────────────────────────────

mkdirSync(pluginDir, { recursive: true });
mkdirSync(join(pluginDir, 'hooks'), { recursive: true });

if (type !== 'universe' && type !== 'stack') {
  mkdirSync(join(pluginDir, 'scripts'), { recursive: true });
}

// Archivos comunes a todos los tipos
writeFileSync(join(pluginDir, 'manifest.toml'), MANIFEST);
writeFileSync(join(pluginDir, 'README.md'), README);

// SKILL.md — para skills, y también para provider/discipline (describe qué hacen)
if (type !== 'universe' && type !== 'stack') {
  writeFileSync(join(pluginDir, 'SKILL.md'), SKILL_MD);
}

// tools.json — solo para provider y discipline
if (type === 'provider' || type === 'discipline') {
  writeFileSync(join(pluginDir, 'tools.json'), TOOLS_JSON);
  writeFileSync(join(pluginDir, 'main.py'), MAIN_PY);
  writeFileSync(join(pluginDir, 'hooks/cycle.py'), CYCLE_PY);
}

// main.py para universe
if (type === 'universe') {
  writeFileSync(join(pluginDir, 'main.py'), UNIVERSE_PY);
}

// main.py genérico para skill
if (type === 'skill') {
  writeFileSync(join(pluginDir, 'hooks/cycle.py'), CYCLE_PY);
}

// ── Resumen ────────────────────────────────────────────────────────────────────

const files = [];
files.push('manifest.toml', 'README.md');
if (type !== 'universe' && type !== 'stack') files.push('SKILL.md');
if (type === 'provider' || type === 'discipline') files.push('tools.json', 'main.py', 'hooks/cycle.py');
if (type === 'skill') files.push('hooks/cycle.py');
if (type === 'universe') files.push('main.py');

console.log(`
✓ Plugin '${name}' creado en plugins/${name}/

Archivos generados:
${files.map(f => `  • ${f}`).join('\n')}

Próximos pasos:
  1. Edita manifest.toml   → define credenciales, config y hooks
  2. Edita SKILL.md        → escribe las instrucciones para el LLM
${type === 'provider' || type === 'discipline' ? `  3. Edita tools.json      → declara las funciones que el LLM puede llamar
  4. Implementa main.py    → lógica Python del plugin` : ''}

Para instalarlo en la plataforma:
  • Sube el directorio a GitHub y usa POST /api/plugins/install con la URL del repo
  • O cópialo directamente a la carpeta plugins/ y regístralo via API
`);

function titleCase(str) {
  return str.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
