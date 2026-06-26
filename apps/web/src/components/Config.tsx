import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { api, type JsonObject } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { Save } from 'lucide-react';

const EXPLICA: Record<string, string> = {
  'risk.portfolio_vol_target': 'Volatilidad anual objetivo de la cartera (vol-targeting).',
  'risk.max_total_exposure': 'Exposición total máxima (1.0 = sin apalancamiento).',
  'risk.allocation': 'current = pesos del ensemble · risk_parity = 1/vol (menos drawdown).',
  'risk.rebalance_band': 'Banda de no-trading: evita rebalanceos por micro-variaciones.',
  'ia_first.enabled': 'Cartera AI-first: la IA decide con criterio propio (2ª llamada LLM/ciclo).',
  'broker.mode': 'Ejecución equities: interno · alpaca_paper · alpaca_live (doble llave).',
  'broker.crypto_mode': 'Ejecución crypto: interno · binance_testnet · binance_live.',
  'loop.cycle_minutes':
    'Cadencia del ciclo. Más frecuencia ≠ más retorno (las velas son 6h/diarias).',
};

const TODAS = [
  'risk',
  'llm',
  'loop',
  'advisor',
  'signals',
  'ia_first',
  'broker',
  'alerts',
  'data_quality',
  'providers',
  'notifications',
];

function ConfigField({
  path,
  v,
  set,
}: {
  path: string;
  v: unknown;
  set: (path: string, val: unknown) => void;
}) {
  if (typeof v === 'boolean') {
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <Switch checked={v} onCheckedChange={(c) => set(path, c)} />
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
        onChange={(e) => set(path, parseFloat(e.target.value))}
        className="mt-1 w-full rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-ink num outline-none focus:border-accent/50"
      />
    );
  }
  return (
    <input
      value={String(v)}
      onChange={(e) => set(path, e.target.value)}
      className="mt-1 w-full rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent/50"
    />
  );
}

function ConfigContent({
  data,
  setData,
  run,
  busy,
  only,
}: {
  data: JsonObject;
  setData: React.Dispatch<React.SetStateAction<JsonObject | null>>;
  run: ReturnType<typeof useAction>['run'];
  busy: boolean;
  only?: string[];
}) {
  const set = (path: string, val: unknown) => {
    const next = structuredClone(data) as Record<string, Record<string, unknown>>;
    const ks = path.split('.');
    let o: Record<string, unknown> = next;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] as Record<string, unknown>;
    o[ks[ks.length - 1]] = val;
    setData(next as JsonObject);
  };

  const save = () =>
    run(() => api.saveConfig(data).then((r) => setData((r as { config: JsonObject }).config)), {
      success: '✓ Guardado y validado. Aplica desde el próximo ciclo.',
    });

  const scalarSecciones = only ? TODAS.filter((s) => only.includes(s)) : TODAS;

  return (
    <div className="space-y-5">
      {scalarSecciones
        .filter((s) => data[s])
        .map((sec) => (
          <Card key={sec}>
            <CardHeader title={sec} />
            <CardBody className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
              {Object.entries(data[sec] as Record<string, unknown>)
                .filter(([, v]) => typeof v !== 'object')
                .map(([k, v]) => {
                  const path = `${sec}.${k}`;
                  return (
                    <label key={k} className="block">
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] text-ink num">{k}</span>
                      </div>
                      <ConfigField path={path} v={v} set={set} />
                      {EXPLICA[path] && (
                        <span className="mt-0.5 block text-[11px] text-mut leading-snug">
                          {EXPLICA[path]}
                        </span>
                      )}
                    </label>
                  );
                })}
            </CardBody>
          </Card>
        ))}
      <div className="sticky bottom-4 flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-accent/90 px-5 py-2.5 text-sm font-semibold text-bg hover:bg-accent shadow-lg disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          Guardar configuración
        </button>
        <Badge tone="warn">
          los parámetros del ensemble están bajo candado (no editables aquí)
        </Badge>
      </div>
    </div>
  );
}

export default function Config({ only }: { only?: string[] } = {}) {
  const { data, loading, error, reload, setData } = useResource<JsonObject>(() => api.config());
  const { busy, run } = useAction();

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!data}
      loadingText="Cargando configuración…"
    >
      {data && <ConfigContent data={data} setData={setData} run={run} busy={busy} only={only} />}
    </AsyncBoundary>
  );
}
