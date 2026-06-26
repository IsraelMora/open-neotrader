import { useMemo } from 'react';
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
import { AsyncBoundary } from './ui/AsyncBoundary';
import { api, type JsonObject } from '../lib/api';
import { useResource } from '../lib/useResource';
import { useChartTheme, VARS } from '../lib/useChartTheme';

interface NavPoint {
  ts: string;
  nav: number;
}

interface NavSeries {
  [key: string]: NavPoint[];
}

interface NavHistoryResponse extends JsonObject {
  series?: NavSeries;
}

interface ChartPoint {
  ts: string;
  [key: string]: string | number;
}

function buildChartData(
  series: NavSeries,
  keys: string[],
): { data: ChartPoint[]; bases: Record<string, number> } {
  const bases: Record<string, number> = {};
  const merged: Record<string, ChartPoint> = {};

  for (const k of keys) {
    const s = series[k];
    if (!s.length) continue;
    bases[k] = s[0].nav;
    for (const pt of s) {
      const t = pt.ts.slice(5, 16); // MM-DD HH:MM
      if (!merged[pt.ts]) merged[pt.ts] = { ts: t };
      merged[pt.ts][k] = +((pt.nav / bases[k] - 1) * 100).toFixed(2);
    }
  }

  const data = Object.keys(merged)
    .sort()
    .map((k) => merged[k]);

  return { data, bases };
}

function tooltipFormatter(v: number): string {
  return (v >= 0 ? '+' : '') + v + '%';
}

export default function NavChart() {
  const { data, loading, error, reload } = useResource<NavHistoryResponse>(
    () => api.navHistory() as unknown as Promise<NavHistoryResponse>,
    { pollMs: 30000 },
  );

  const tema = useChartTheme();

  const { carteras, chartData } = useMemo(() => {
    const series = data?.series ?? {};
    const keys = Object.keys(series).filter((k) => !['lab', 'plan'].includes(k));
    const { data: chartPoints } = buildChartData(series, keys);
    return { carteras: keys, chartData: chartPoints };
  }, [data]);

  const color = (i: number) => tema?.serie[i % VARS.length] || '#888';

  return (
    <Card>
      <CardHeader
        title="Curva de rendimiento (base 100)"
        hint="Retorno % de cada cartera desde su inicio. Las políticas compiten sobre el mismo mercado."
      />
      <CardBody>
        <AsyncBoundary
          loading={loading}
          error={error}
          onRetry={reload}
          isEmpty={!data || chartData.length < 2}
          emptyText="Aún se acumulan puntos de NAV (se llenan cada ciclo)."
        >
          {data && chartData.length >= 2 && tema && (
            <div>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={chartData} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <defs>
                    {carteras.map((k, i) => (
                      <linearGradient key={k} id={`grad-${k}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color(i)} stopOpacity={0.35} />
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
                    formatter={tooltipFormatter}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {carteras.map((k, i) => (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      stroke={color(i)}
                      strokeWidth={2}
                      fill={`url(#grad-${k})`}
                      dot={false}
                      connectNulls
                      activeDot={{ r: 3 }}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </AsyncBoundary>
      </CardBody>
    </Card>
  );
}
