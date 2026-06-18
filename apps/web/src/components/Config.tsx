import { useEffect, useState } from 'react';
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

export default function Config({ only }: { only?: string[] } = {}) {
  const [cfg, setCfg] = useState<JsonObject | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    api
      .config()
      .then(setCfg)
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);
  if (!cfg) return <div className="text-mut text-sm animate-pulse">Cargando configuración…</div>;

  const set = (path: string, val: unknown) => {
    const next = structuredClone(cfg) as Record<string, Record<string, unknown>>;
    const ks = path.split('.');
    let o: Record<string, unknown> = next;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] as Record<string, unknown>;
    o[ks[ks.length - 1]] = val;
    setCfg(next as JsonObject);
  };
  const save = async () => {
    try {
      const r = await api.saveConfig(cfg);
      setCfg((r as { config: JsonObject }).config);
      setMsg({ ok: true, text: '✓ Guardado y validado. Aplica desde el próximo ciclo.' });
    } catch (e: unknown) {
      setMsg({ ok: false, text: '✗ ' + (e instanceof Error ? e.message : 'error') });
    }
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
  const scalarSecciones = only ? TODAS.filter((s) => only.includes(s)) : TODAS;
  return (
    <div className="space-y-5">
      {msg && (
        <div
          className={`rounded-md border px-4 py-2.5 text-sm ${msg.ok ? 'border-accent/40 bg-accent/10 text-accent' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {msg.text}
        </div>
      )}
      {scalarSecciones
        .filter((s) => cfg[s])
        .map((sec) => (
          <Card key={sec}>
            <CardHeader title={sec} />
            <CardBody className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
              {Object.entries(cfg[sec] as Record<string, unknown>)
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
          className="inline-flex items-center gap-2 rounded-md bg-accent/90 px-5 py-2.5 text-sm font-semibold text-bg hover:bg-accent shadow-lg"
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
