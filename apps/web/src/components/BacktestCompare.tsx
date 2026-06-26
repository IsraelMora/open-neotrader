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
import { AsyncBoundary } from './ui/AsyncBoundary';
import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { api } from '../lib/api';
import { useChartTheme, VARS } from '../lib/useChartTheme';

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

interface BacktestResult {
  series: Series;
  errors: Record<string, string>;
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
  const {
    data: strategies,
    loading: strategiesLoading,
    error: strategiesError,
    reload: reloadStrategies,
  } = useResource<Strategy[]>(() => api.strategies() as unknown as Promise<Strategy[]>);

  const {
    data: providers,
    loading: providersLoading,
    error: providersError,
    reload: reloadProviders,
  } = useResource<Provider[]>(() => api.backtestProviders());

  const { busy, run } = useAction();

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [providerId, setProviderId] = useState('backtester');
  const [years, setYears] = useState(2);
  const TRADING_DAYS_PER_YEAR = 252;
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [chartKeys, setChartKeys] = useState<string[]>([]);
  const tema = useChartTheme();

  // Set a default providerId once providers load
  useEffect(() => {
    if (providers && providers.length && !providers.some((x) => x.id === 'backtester')) {
      setProviderId(providers[0].id);
    }
  }, [providers]);

  const toggle = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runBacktest = () => {
    if (sel.size === 0) return;
    void run(async () => {
      const r = await api.backtestCompare({
        strategy_ids: [...sel],
        provider_id: providerId,
        // The backend works in bars; convert chosen years (daily ~ 252/year).
        bars: Math.max(60, Math.round(years * TRADING_DAYS_PER_YEAR)),
      });
      const k = Object.keys(r.series);
      setChartKeys(k);
      setChartData(buildChartData(r.series, k));
      setResult(r);
      if (k.length === 0)
        throw new Error('Ningún backtest produjo resultados. Mirá los errores abajo.');
    });
  };

  const color = (i: number) => tema?.serie[i % VARS.length] || '#888';

  const loadingLists = strategiesLoading || providersLoading;
  const errorLists = strategiesError ?? providersError;
  const reloadLists = () => {
    reloadStrategies();
    reloadProviders();
  };

  return (
    <AsyncBoundary
      loading={loadingLists}
      error={errorLists}
      onRetry={reloadLists}
      isEmpty={!strategies && !providers}
      loadingText="Cargando estrategias y providers…"
    >
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
                {(strategies ?? []).length === 0 && (
                  <span className="text-[12px] text-mut">
                    No hay estrategias. Creá algunas primero.
                  </span>
                )}
                {(strategies ?? []).map((s) => {
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
                  {(providers ?? []).length === 0 && <option value="backtester">backtester</option>}
                  {(providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="mb-1 text-[12px] text-mut">Años a probar</div>
                <input
                  type="number"
                  value={years}
                  min={0.5}
                  max={20}
                  step={0.5}
                  onChange={(e) => setYears(Number(e.target.value))}
                  className="w-28 rounded-md border border-edge/60 bg-transparent px-2 py-1.5 text-[13px] text-ink outline-none"
                />
              </div>
              <button
                onClick={runBacktest}
                disabled={busy || sel.size === 0}
                className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-bg disabled:opacity-50"
              >
                {busy ? 'Corriendo…' : 'Correr backtest'}
              </button>
            </div>

            {sel.size === 0 && (
              <div className="text-[12px] text-mut">
                Seleccioná al menos una estrategia para correr el backtest.
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Comportamiento de cada estrategia"
            hint="Retorno % (base 100) a lo largo del período. Mayor = mejor."
          />
          <CardBody>
            {chartData.length < 2 || !tema ? (
              <p className="py-8 text-center text-sm text-mut">
                Elegí estrategias y corré un backtest para ver el gráfico.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={340}>
                <AreaChart data={chartData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <defs>
                    {chartKeys.map((k, i) => (
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
                  {chartKeys.map((k, i) => (
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
            {result && Object.keys(result.errors).length > 0 && (
              <div className="mt-3 space-y-1">
                {Object.entries(result.errors).map(([k, v]) => (
                  <div key={k} className="text-[11px] text-danger">
                    <Badge tone="danger">{k}</Badge> {v}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </AsyncBoundary>
  );
}
