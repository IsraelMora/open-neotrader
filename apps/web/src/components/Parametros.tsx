import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { api, type JsonObject } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { Save, Lock, Bot, SlidersHorizontal } from 'lucide-react';

// Explicaciones de los parámetros manuales (riesgo/señales).
const EXPLICA: Record<string, string> = {
  'risk.portfolio_vol_target': 'Volatilidad anual objetivo de la cartera (vol-targeting).',
  'risk.cov_window': 'Ventana (días) para estimar la matriz de covarianzas.',
  'risk.max_total_exposure': 'Exposición total máxima (1.0 = sin apalancamiento).',
  'risk.rebalance_band': 'Banda de no-trading: evita rebalanceos por micro-variaciones.',
  'risk.shadow_band': 'Banda de rebalanceo de la cartera sombra (mecánica pura).',
  'risk.allocation': 'current = pesos del ensemble · risk_parity = 1/vol (menos drawdown).',
  'signals.historical_flags': 'Banderas históricas del orquestador (solo mantienen/recortan).',
  'signals.connors_overlay': 'Overlay de reversión a la media Connors RSI(2) (adoptado).',
};
// Campos que la autogestión GENERAL adopta automáticamente (param_adoption).
const AUTO_ADOPTA = new Set([
  'risk.portfolio_vol_target',
  'risk.rebalance_band',
  'signals.bh_symbols',
]);
const SECCIONES = ['risk', 'signals'];

function ParamField({
  path,
  v,
  manualBloqueado,
  set,
}: {
  path: string;
  v: unknown;
  manualBloqueado: boolean;
  set: (path: string, val: unknown) => void;
}) {
  if (typeof v === 'boolean') {
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <Switch
          checked={v}
          disabled={manualBloqueado}
          onCheckedChange={(c) => {
            set(path, c);
          }}
        />
        <span className="text-[12px] text-mut">{v ? 'activado' : 'desactivado'}</span>
      </div>
    );
  }
  if (typeof v === 'number') {
    return (
      <input
        type="number"
        value={v}
        step="any"
        disabled={manualBloqueado}
        onChange={(e) => set(path, parseFloat(e.target.value))}
        className="mt-1 w-full rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-ink num outline-none focus:border-accent/50 disabled:opacity-60"
      />
    );
  }
  return (
    <input
      value={String(v)}
      disabled={manualBloqueado}
      onChange={(e) => set(path, e.target.value)}
      className="mt-1 w-full rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent/50 disabled:opacity-60"
    />
  );
}

function modoLabel(generalBloqueado: boolean, general: boolean): string {
  if (generalBloqueado) return 'deshabilitado (manda por-operación)';
  if (general) return 'activado';
  return 'desactivado';
}

function modoTone(generalBloqueado: boolean, general: boolean): string {
  if (generalBloqueado) return 'mut';
  if (general) return 'ok';
  return 'mut';
}

function bloqueoMsg(porOp: boolean): string {
  if (porOp) {
    return 'Edición pausada: la IA gestiona la cartera por operación (AI-first). Desactiva la gestión por operación para editar los parámetros a mano.';
  }
  return 'Edición pausada: la autogestión general adopta los parámetros óptimos validados cada cooldown. Desactiva la autogestión general para editar a mano.';
}

function ParamRow({
  sec,
  k,
  v,
  general,
  manualBloqueado,
  set,
}: {
  sec: string;
  k: string;
  v: unknown;
  general: boolean;
  manualBloqueado: boolean;
  set: (path: string, val: unknown) => void;
}) {
  const path = `${sec}.${k}`;
  return (
    <label key={path} className="block">
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-ink num">{path}</span>
        {general && AUTO_ADOPTA.has(path) && (
          <span className="inline-flex items-center gap-1 text-[10px] text-warn">
            <Bot className="h-3 w-3" />
            IA
          </span>
        )}
      </div>
      <ParamField path={path} v={v} manualBloqueado={manualBloqueado} set={set} />
      {EXPLICA[path] && (
        <span className="mt-0.5 block text-[11px] text-mut leading-snug">{EXPLICA[path]}</span>
      )}
    </label>
  );
}

function ParametrosContent({
  data,
  setData,
}: {
  data: JsonObject;
  setData: (d: JsonObject) => void;
}) {
  const { busy, run } = useAction();

  const advisor = data.advisor as Record<string, unknown> | undefined;
  const iaFirst = data.ia_first as Record<string, unknown> | undefined;
  const general = !!advisor?.auto_mode; // ① autogestión general
  const porOp = !!iaFirst?.enabled; // ② gestión por operación (AI-first)

  // Precedencia de autonomía: por-operación > general > manual.
  const manualBloqueado = general || porOp;
  const generalBloqueado = porOp;

  const set = (path: string, val: unknown) => {
    const next = structuredClone(data) as Record<string, Record<string, unknown>>;
    const ks = path.split('.');
    let o: Record<string, unknown> = next;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] as Record<string, unknown>;
    o[ks[ks.length - 1]] = val;
    setData(next as JsonObject);
  };

  // Los toggles de automatización guardan al instante (cambian el modo).
  function handleSetAuto(sec: string, key: string, val: unknown) {
    const next = structuredClone(data) as Record<string, Record<string, unknown>>;
    next[sec][key] = val;
    void run(
      () =>
        api.saveConfig(next as JsonObject).then((r) => {
          setData((r as { config: JsonObject }).config);
        }),
      { success: '✓ Guardado.' },
    );
  }

  return (
    <div className="space-y-5">
      {/* ───────── Modo de gestión (antes vista Automatización) ───────── */}
      <div className="flex items-center gap-2 text-[12px] text-mut">
        <Bot className="h-4 w-4" /> Modo de gestión de parámetros — quién decide los valores. Más
        automatización = mejor adaptación, más coste de cuota LLM. Precedencia: por-operación &gt;
        general &gt; manual.
      </div>

      <Card>
        <CardHeader
          title="① Autogestión general de parámetros"
          icon={<Bot className="h-4 w-4" />}
          hint="Barato: 1 consulta LLM por cooldown. Adopta solo parámetros YA validados por backtest."
        />
        <CardBody className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              checked={general}
              disabled={generalBloqueado}
              onCheckedChange={(v) => handleSetAuto('advisor', 'auto_mode', v)}
            />
            <Badge tone={modoTone(generalBloqueado, general)}>
              {modoLabel(generalBloqueado, general)}
            </Badge>
          </div>
          <p className="text-[12px] text-mut leading-relaxed">
            Antes de cada ciclo, el agente elige los parámetros ÓPTIMOS entre los candidatos que ya
            pasaron el backtest pre-registrado y los adopta (journaleado como AUTO). No inventa
            parámetros: solo escoge entre los validados. Respeta el candado anti-overfitting.
          </p>
          <div
            className={`flex items-center gap-3 ${generalBloqueado ? 'opacity-40 pointer-events-none' : ''}`}
          >
            <label className="text-[12px] text-mut">Cooldown entre adopciones (h)</label>
            <input
              type="number"
              value={advisor?.auto_cooldown_hours as number | undefined}
              disabled={generalBloqueado}
              onChange={(e) => set('advisor.auto_cooldown_hours', parseInt(e.target.value))}
              onBlur={() =>
                void run(
                  () =>
                    api.saveConfig(data).then((r) => {
                      setData((r as { config: JsonObject }).config);
                    }),
                  { success: '✓ Guardado.' },
                )
              }
              className="w-20 rounded-md border border-edge bg-bg px-2 py-1 text-sm text-ink num outline-none focus:border-accent/50 disabled:opacity-50"
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="② Gestión por operación (AI-first)"
          icon={<Bot className="h-4 w-4" />}
          hint="Más costoso: 2ª consulta LLM cada ciclo. La IA decide la cartera completa con criterio propio."
        />
        <CardBody className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              checked={porOp}
              onCheckedChange={(v) => handleSetAuto('ia_first', 'enabled', v)}
            />
            <Badge tone={porOp ? 'ok' : 'mut'}>{porOp ? 'activado' : 'desactivado'}</Badge>
          </div>
          <p className="text-[12px] text-mut leading-relaxed">
            En cada ciclo, la IA recibe todas las señales + skills de estrategia y propone la
            asignación con su propio criterio (cartera "ia"), dentro de un sobre de riesgo de acero
            (sin apalancamiento, tope por activo). Compite en paper contra principal/sombra — el NAV
            decide.
            <strong className="text-warn"> Consume una 2ª llamada LLM por ciclo</strong> (más
            cuota).
          </p>
          <div className="flex items-center gap-3">
            <label className="text-[12px] text-mut">Tope por activo</label>
            <input
              type="number"
              step="0.05"
              value={iaFirst?.per_asset_cap as number | undefined}
              onChange={(e) => set('ia_first.per_asset_cap', parseFloat(e.target.value))}
              onBlur={() =>
                void run(
                  () =>
                    api.saveConfig(data).then((r) => {
                      setData((r as { config: JsonObject }).config);
                    }),
                  { success: '✓ Guardado.' },
                )
              }
              className="w-20 rounded-md border border-edge bg-bg px-2 py-1 text-sm text-ink num outline-none focus:border-accent/50"
            />
          </div>
        </CardBody>
      </Card>

      {/* ───────── Parámetros manuales (riesgo/señales) ───────── */}
      <Card>
        <CardHeader
          title="Parámetros (riesgo · señales)"
          icon={
            manualBloqueado ? (
              <Lock className="h-4 w-4" />
            ) : (
              <SlidersHorizontal className="h-4 w-4" />
            )
          }
          hint="Valores mecánicos del ensemble. Editables solo en modo manual."
        />
        <CardBody>
          {manualBloqueado && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5 text-[12px] text-warn">
              <Lock className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{bloqueoMsg(porOp)}</span>
            </div>
          )}
          <div
            className={`grid sm:grid-cols-2 gap-x-6 gap-y-3 ${manualBloqueado ? 'opacity-50 pointer-events-none select-none' : ''}`}
          >
            {SECCIONES.filter((s) => data[s]).flatMap((sec) =>
              Object.entries(data[sec] as Record<string, unknown>)
                .filter(([, v]) => typeof v !== 'object')
                .map(([k, v]) => (
                  <ParamRow
                    key={`${sec}.${k}`}
                    sec={sec}
                    k={k}
                    v={v}
                    general={general}
                    manualBloqueado={manualBloqueado}
                    set={set}
                  />
                )),
            )}
          </div>
        </CardBody>
      </Card>

      <div className="sticky bottom-4 flex items-center gap-3">
        <button
          onClick={() =>
            void run(
              () =>
                api.saveConfig(data).then((r) => {
                  setData((r as { config: JsonObject }).config);
                }),
              { success: '✓ Guardado y validado. Aplica desde el próximo ciclo.' },
            )
          }
          disabled={manualBloqueado || busy}
          className="inline-flex items-center gap-2 rounded-md bg-accent/90 px-5 py-2.5 text-sm font-semibold text-bg hover:bg-accent shadow-lg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save className="h-4 w-4" />
          Guardar parámetros
        </button>
        <Badge tone="warn">
          los parámetros del ensemble están bajo candado (flujo journal→backtest→relock)
        </Badge>
      </div>
    </div>
  );
}

export default function Parametros() {
  const { data, loading, error, reload, setData } = useResource<JsonObject>(() => api.config());

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!data}
      loadingText="Cargando parámetros…"
    >
      {data && <ParametrosContent data={data} setData={setData} />}
    </AsyncBoundary>
  );
}
