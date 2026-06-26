import { api } from '../lib/api';
import { fmt } from '../lib/utils';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import NavChart from './NavChart';
import { Trophy } from 'lucide-react';
import { NumberTicker } from './magic/NumberTicker';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { useResource } from '../lib/useResource';
import { AsyncBoundary } from './ui/AsyncBoundary';

const POLITICA: Record<string, string> = {
  principal: 'Ensemble mecánico + LLM que solo veta/recorta',
  sombra: 'Ensemble mecánico puro (sin LLM) — control',
  ia: 'AI-first: la IA decide con criterio propio + skills',
  alpaca: 'Espejo en vivo Alpaca (equities)',
  binance: 'Espejo en vivo Binance (crypto)',
};

interface CheckItem {
  status: 'FAIL' | 'WARN' | 'OK';
}

interface Cartera {
  nav_actual: number;
  ret_total_pct: number;
  sharpe: number | null;
  max_dd_pct: number | null;
}

interface PortfoliosData {
  carteras: Record<string, Cartera>;
  lider_por_retorno: string | null;
  nota: string;
}

interface DoctorData {
  checks: CheckItem[];
}

export default function Dashboard() {
  const {
    data: comp,
    loading,
    error,
    reload,
  } = useResource<PortfoliosData>(() => api.portfolios() as unknown as Promise<PortfoliosData>, {
    pollMs: 15000,
  });
  const { data: doctor } = useResource<DoctorData>(
    () => api.doctor() as unknown as Promise<DoctorData>,
    { pollMs: 15000 },
  );

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!comp}
      loadingText="Cargando estado…"
    >
      {comp && <DashboardContent comp={comp} doctor={doctor ?? null} />}
    </AsyncBoundary>
  );
}

function DashboardContent({ comp, doctor }: { comp: PortfoliosData; doctor: DoctorData | null }) {
  const carteras = comp.carteras || {};
  const lider = comp.lider_por_retorno;
  const checks = doctor?.checks || [];
  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'WARN').length;
  const orden = ['principal', 'sombra', 'ia', 'alpaca', 'binance'].filter((k) => carteras[k]);

  let estadoTone = 'ok';
  if (fails) estadoTone = 'danger';
  else if (warns) estadoTone = 'warn';

  return (
    <div className="space-y-6 animate-[fadeIn_.4s_ease]">
      {/* Salud del sistema */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 stagger">
        <Stat
          label="Estado del sistema"
          value={fails ? 'REVISAR' : 'SANO'}
          tone={estadoTone}
          sub={`${checks.length} chequeos · ${fails} fallos · ${warns} avisos`}
        />
        <Card className="overflow-hidden relative">
          <CardBody>
            <div className="text-[11px] uppercase tracking-wide text-mut">Carteras activas</div>
            <div className="mt-1 text-2xl font-bold tracking-tight text-info">
              <NumberTicker value={orden.length} />
            </div>
            <div className="mt-1 text-[11px] text-mut leading-snug">
              políticas compitiendo en paper
            </div>
          </CardBody>
        </Card>
        <Stat
          label="Líder por retorno"
          value={lider ? lider.toUpperCase() : '—'}
          tone="ok"
          sub="experimento AI-first vs disciplina"
        />
        <Stat
          label="Experimento ia"
          value={carteras.ia ? 'ACTIVA' : 'inactiva'}
          tone={carteras.ia ? 'ok' : 'mut'}
          sub="la IA con criterio propio"
        />
      </div>

      {/* Comparación de carteras */}
      <Card>
        <CardHeader
          title="Carteras en competición"
          icon={<Trophy className="h-4 w-4" />}
          hint="Tres políticas de decisión sobre el mismo mercado. El NAV decide cuál gana — sin opinión, solo datos."
        />
        <CardBody className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cartera</TableHead>
                <TableHead>Política</TableHead>
                <TableHead className="text-right">NAV</TableHead>
                <TableHead className="text-right">Retorno</TableHead>
                <TableHead className="text-right">Sharpe</TableHead>
                <TableHead className="text-right">maxDD</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orden.map((k) => {
                const m = carteras[k];
                const win = k === lider;
                return (
                  <TableRow key={k} className={win ? 'bg-accent/[0.04]' : ''}>
                    <TableCell>
                      <span className="font-semibold text-ink">{k}</span>
                      {win && (
                        <span className="ml-2">
                          <Badge tone="ok">líder</Badge>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-mut text-[12px] max-w-[280px]">
                      {POLITICA[k] ?? '—'}
                    </TableCell>
                    <TableCell className="text-right num text-ink">
                      {fmt.money(m.nav_actual)}
                    </TableCell>
                    <TableCell
                      className={`text-right num ${m.ret_total_pct >= 0 ? 'text-accent' : 'text-danger'}`}
                    >
                      {fmt.pct(m.ret_total_pct)}
                    </TableCell>
                    <TableCell className="text-right num text-mut">
                      {m.sharpe ?? <span className="text-mut/50">n/a</span>}
                    </TableCell>
                    <TableCell className="text-right num text-warn">
                      {m.max_dd_pct != null ? (
                        m.max_dd_pct + '%'
                      ) : (
                        <span className="text-mut/50">n/a</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="px-5 py-3 text-[11px] text-mut border-t border-edge/50">{comp.nota}</p>
        </CardBody>
      </Card>

      <NavChart />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: string;
  sub: string;
}) {
  const col: Record<string, string> = {
    ok: 'text-accent',
    danger: 'text-danger',
    warn: 'text-warn',
    info: 'text-info',
    mut: 'text-mut',
  };
  return (
    <Card className="overflow-hidden">
      <CardBody>
        <div className="text-[11px] uppercase tracking-wide text-mut">{label}</div>
        <div className={`mt-1 text-2xl font-bold tracking-tight ${col[tone] ?? 'text-ink'}`}>
          {value}
        </div>
        <div className="mt-1 text-[11px] text-mut leading-snug">{sub}</div>
      </CardBody>
    </Card>
  );
}
