import { useEffect, useState } from 'react';
import { api, type JsonObject } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Check } from 'lucide-react';

const MODES: Record<string, { field: string; opts: [string, string][] }> = {
  alpaca: {
    field: 'mode',
    opts: [
      ['interno', 'desactivado (paper interno)'],
      ['alpaca_paper', 'paper (órdenes reales sin dinero)'],
      ['alpaca_live', 'LIVE (dinero real, doble llave)'],
    ],
  },
  binance: {
    field: 'crypto_mode',
    opts: [
      ['interno', 'desactivado (paper interno)'],
      ['binance_testnet', 'testnet (sandbox)'],
      ['binance_live', 'LIVE (dinero real, doble llave)'],
    ],
  },
};

interface ProviderItem {
  plugin_id: string;
  [key: string]: unknown;
}

export default function Providers() {
  const [provs, setProvs] = useState<ProviderItem[] | null>(null);
  const [cfg, setCfg] = useState<JsonObject | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const load = () => {
    api.config().then((d) => setCfg(d));
    api.providers().then((d) => setProvs(d as unknown as ProviderItem[]));
  };
  useEffect(() => {
    load();
  }, []);
  if (!provs || !cfg)
    return <div className="text-mut text-sm animate-pulse">Cargando proveedores…</div>;

  const save = async (next: JsonObject) => {
    try {
      const r = await api.saveConfig(next);
      setCfg((r as { config: JsonObject }).config);
      setMsg({ ok: true, t: '✓ Guardado. Aplica desde el próximo ciclo.' });
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    }
  };
  const setMode = (prov: string, val: string) => {
    const next = structuredClone(cfg) as Record<string, Record<string, unknown>>;
    if (!next.broker) next.broker = {};
    next.broker[MODES[prov].field] = val;
    save(next as JsonObject);
  };
  const toggleSym = (prov: string, sym: string) => {
    const next = structuredClone(cfg) as Record<string, Record<string, unknown>>;
    if (!next.providers) next.providers = {};
    const key = prov + '_universe';
    const cur: string[] = (next.providers[key] as string[]) || [];
    next.providers[key] = cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym];
    save(next as JsonObject);
  };

  const cfgTyped = cfg as Record<string, Record<string, unknown>>;

  return (
    <div className="space-y-5">
      {msg && (
        <div
          className={`rounded-md border px-4 py-2.5 text-sm ${msg.ok ? 'border-accent/40 bg-accent/10 text-accent' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {msg.t}
        </div>
      )}
      <p className="text-[12px] text-mut">
        Activa qué proveedor ejecuta y con qué activos. Sub-universo vacío = el proveedor opera
        TODOS los de su clase. Requiere credenciales (pestaña Credenciales).
      </p>
      {['alpaca', 'binance'].map((prov) => {
        const sub: string[] =
          (cfgTyped.providers && (cfgTyped.providers[prov + '_universe'] as string[])) || [];
        const mode =
          (cfgTyped.broker && (cfgTyped.broker[MODES[prov].field] as string)) || 'interno';
        const activo = mode !== 'interno';
        const clase = prov === 'alpaca' ? 'acciones/ETFs' : 'criptomonedas';
        const universe = cfgTyped.universe || {};
        const candidatos = Object.keys(universe).filter(
          (k) => universe[k] === (prov === 'alpaca' ? 'equity' : 'crypto'),
        );

        return (
          <Card key={prov}>
            <CardHeader
              title={prov.toUpperCase() + ' · ' + clase}
              hint={prov === 'alpaca' ? 'Equities (SPY, QQQ, ETFs…)' : 'Crypto (BTC, ETH…)'}
            />
            <CardBody className="space-y-3">
              <div className="flex items-center gap-3">
                <label className="text-[12px] text-mut w-32">Modo de ejecución</label>
                <Select value={mode} onValueChange={(v) => setMode(prov, v)}>
                  <SelectTrigger className="w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODES[prov].opts.map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Badge tone={activo ? 'ok' : 'mut'}>{activo ? 'activo' : 'inactivo'}</Badge>
              </div>
              <div>
                <div className="text-[12px] text-mut mb-1.5">
                  Sub-universo ({sub.length ? sub.join(', ') : 'todos los de su clase'}):
                </div>
                <div className="flex flex-wrap gap-2">
                  {candidatos.map((sym) => {
                    const on = sub.includes(sym);
                    return (
                      <button
                        key={sym}
                        onClick={() => toggleSym(prov, sym)}
                        className={`rounded-md border px-2.5 py-1 text-[12px] num ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-edge bg-edge/30 text-mut hover:text-ink'}`}
                      >
                        {on && <Check className="inline h-3 w-3 -mt-0.5 mr-1" />}
                        {sym}
                      </button>
                    );
                  })}
                  {!candidatos.length && (
                    <span className="text-mut text-[12px]">
                      sin activos de esta clase en el universo
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-mut mt-1.5">
                  Vacío = opera todos. Marca símbolos para restringir (ej. solo BTC).
                </p>
              </div>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
