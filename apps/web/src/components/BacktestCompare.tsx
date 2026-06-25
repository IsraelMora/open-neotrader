import { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { api } from '../lib/api';

const VARS = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--primary',
  '--info',
];

interface Theme {
  serie: string[];
  grid: string;
  tick: string;
  tip: string;
  tipBorde: string;
  tipTexto: string;
}
function leerTema(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  return {
    serie: VARS.map(v),
    grid: v('--border'),
    tick: v('--muted-foreground'),
    tip: v('--popover'),
    tipBorde: v('--border'),
    tipTexto: v('--popover-foreground'),
  };
}

interface Strategy {
  id: string;
  name: string;
}
interface Provider {
  id: string;
  name: string;
  active: boolean;
}
type Series = Record<string, { ts: string; equity: number }[]>;
interface ChartPoint {
  ts: string;
  [k: string]: string | number;
}

/** Normaliza cada serie a retorno % (base 100) y las fusiona por fecha. */
function buildChartData(series: Series, keys: string[]): ChartPoint[] {
  const merged: Record<string, ChartPoint> = {};
  for (const k of keys) {
    const s = series[k];
    if (!s || !s.length) continue;
    const base = s[0].equity || 1;
    for (const pt of s) {
      if (!merged[pt.ts]) merged[pt.ts] = { ts: pt.ts.slice(0, 10) };
      merged[pt.ts][k] = +((pt.equity / base - 1) * 100).toFixed(2);
    }
  }
  return Object.keys(merged)
    .sort()
    .map((k) => merged[k]);
}

export default function BacktestCompare() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [providerId, setProviderId] = useState('backtester');
  const [bars, setBars] = useState(500);
  const [data, setData] = useState<ChartPoint[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tema, setTema] = useState<Theme | null>(() =>
    typeof document !== 'undefined' ? leerTema() : null,
  );

  useEffect(() => {
    setTema(leerTema());
    const obs = new MutationObserver(() => setTema(leerTema()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    api
      .strategies()
      .then((d) => setStrategies(d as unknown as Strategy[]))
      .catch(() => undefined);
    api
      .backtestProviders()
      .then((p) => {
        setProviders(p);
        if (p.length && !p.some((x) => x.id === 'backtester')) setProviderId(p[0].id);
      })
      .catch(() => undefined);
  }, []);

  const toggle = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    if (sel.size === 0) {
      setMsg('Seleccioná al menos una estrategia.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.backtestCompare({
        strategy_ids: [...sel],
        provider_id: providerId,
        bars,
      });
      const k = Object.keys(r.series);
      setKeys(k);
      setData(buildChartData(r.series, k));
      setErrors(r.errors);
      if (k.length === 0) setMsg('Ningún backtest produjo resultados. Mirá los errores abajo.');
    } catch (e: unknown) {
      setMsg('✗ ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setBusy(false);
    }
  };

  const color = (i: number) => tema?.serie[i % VARS.length] || '#888';

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Competencia por backtest"
          hint="Elegí estrategias, el motor de backtest (provider) y cuántas barras probar. El gráfico compara el retorno de cada estrategia sobre el mismo período histórico."
        />
        <CardBody className="space-y-4">
          <div>
            <div className="mb-1.5 text-[12px] text-mut">Estrategias a comparar</div>
            <div className="flex flex-wrap gap-2">
              {strategies.length === 0 && (
                <span className="text-[12px] text-mut">
                  No hay estrategias. Creá algunas primero.
                </span>
              )}
              {strategies.map((s) => {
                const on = sel.has(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggle(s.id)}
                    className={`rounded-md border px-2.5 py-1 text-[12px] ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-edge bg-edge/30 text-mut hover:text-ink'}`}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="mb-1 text-[12px] text-mut">Motor (provider)</div>
              <select
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="rounded-md border border-edge/60 bg-transparent px-2 py-1.5 text-[13px] text-ink outline-none"
              >
                {providers.length === 0 && <option value="backtester">backtester</option>}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1 text-[12px] text-mut">Barras (período)</div>
              <input
                type="number"
                value={bars}
                min={60}
                max={5000}
                onChange={(e) => setBars(Number(e.target.value))}
                className="w-28 rounded-md border border-edge/60 bg-transparent px-2 py-1.5 text-[13px] text-ink outline-none"
              />
            </div>
            <button
              onClick={() => void run()}
              disabled={busy}
              className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-bg disabled:opacity-50"
            >
              {busy ? 'Corriendo…' : 'Correr backtest'}
            </button>
          </div>

          {msg && <div className="text-[12px] text-danger">{msg}</div>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Comportamiento de cada estrategia"
          hint="Retorno % (base 100) a lo largo del período. Mayor = mejor."
        />
        <CardBody>
          {data.length < 2 || !tema ? (
            <p className="py-8 text-center text-sm text-mut">
              Elegí estrategias y corré un backtest para ver el gráfico.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <AreaChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <defs>
                  {keys.map((k, i) => (
                    <linearGradient key={k} id={`bt-${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color(i)} stopOpacity={0.32} />
                      <stop offset="100%" stopColor={color(i)} stopOpacity={0.02} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={tema.grid} strokeOpacity={0.4} />
                <XAxis dataKey="ts" tick={{ fill: tema.tick, fontSize: 10 }} stroke={tema.grid} />
                <YAxis
                  tick={{ fill: tema.tick, fontSize: 10 }}
                  stroke={tema.grid}
                  tickFormatter={(v: number) => v + '%'}
                />
                <Tooltip
                  contentStyle={{
                    background: tema.tip,
                    border: `1px solid ${tema.tipBorde}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: tema.tipTexto }}
                  itemStyle={{ color: tema.tipTexto }}
                  formatter={(v: number) => (v >= 0 ? '+' : '') + v + '%'}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {keys.map((k, i) => (
                  <Area
                    key={k}
                    type="monotone"
                    dataKey={k}
                    stroke={color(i)}
                    strokeWidth={2}
                    fill={`url(#bt-${i})`}
                    dot={false}
                    connectNulls
                    activeDot={{ r: 3 }}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          )}
          {Object.keys(errors).length > 0 && (
            <div className="mt-3 space-y-1">
              {Object.entries(errors).map(([k, v]) => (
                <div key={k} className="text-[11px] text-danger">
                  <Badge tone="danger">{k}</Badge> {v}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
