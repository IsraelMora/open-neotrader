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

interface DoctorCheck {
  name: string;
  ok: boolean;
  level: 'error' | 'warn' | 'ok';
  detail?: string;
}

interface DoctorData {
  ok?: boolean;
  plugins_registered?: number;
  plugins_active?: number;
  sandbox_reachable?: boolean;
  llm_ready?: boolean;
  llm_backend?: string;
  llm_detail?: string;
  checks?: DoctorCheck[];
}

interface PretestPortfolioRow {
  id: string;
  name: string;
  equity: number;
  return_pct: number;
  max_drawdown_pct: number;
  total_trades: number;
  win_rate: number;
  realized_pnl: number;
  plugin_count: number;
  gate_status: 'READY' | 'NOT_READY';
  expectancy: number;
  avg_win: number;
  avg_loss: number;
  payoff_ratio: number | null;
}

interface PretestCompareData {
  portfolios: PretestPortfolioRow[];
  winner_by_return: string;
  winner_by_risk_adj: string;
}

interface PaperPortfolio {
  equity: number;
  cash: number;
  positions: unknown[];
  hwm: number;
}

interface PortfoliosResponse {
  paper?: PaperPortfolio;
}

interface EstadoInfo {
  label: string;
  tone: string;
  sub: string;
}

interface ChecksSummary {
  hasChecks: boolean;
  fails: number;
  warns: number;
  failingNames: string[];
}

function summarizeChecks(doctor: DoctorData | null): ChecksSummary {
  const checks = doctor?.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    return { hasChecks: false, fails: 0, warns: 0, failingNames: [] };
  }
  const failing = checks.filter((c) => c.level === 'error');
  const warning = checks.filter((c) => c.level === 'warn');
  return {
    hasChecks: true,
    fails: failing.length,
    warns: warning.length,
    failingNames: failing.map((c) => c.name),
  };
}

function estadoFromChecks(summary: ChecksSummary): EstadoInfo {
  const sub = `${summary.fails + summary.warns} avisos/fallos entre chequeos activos`;
  if (summary.fails > 0) return { label: 'REVISAR', tone: 'danger', sub };
  if (summary.warns > 0) return { label: 'AVISOS', tone: 'warn', sub };
  return { label: 'SANO', tone: 'ok', sub };
}

// Sin `checks` estructurados (backend viejo o degradado): mostrar las flags crudas
// en vez de fingir un "SANO" verde que no podemos respaldar con datos.
function estadoFromRawFlags(doctor: DoctorData): EstadoInfo {
  const ok = doctor.sandbox_reachable !== false && doctor.llm_ready !== false;
  const sub = `sandbox: ${doctor.sandbox_reachable ? 'ok' : 'caído'} · llm: ${doctor.llm_ready ? 'ok' : 'sin credencial'}`;
  return ok ? { label: 'SANO', tone: 'ok', sub } : { label: 'REVISAR', tone: 'danger', sub };
}

function computeEstado(doctor: DoctorData | null, summary: ChecksSummary): EstadoInfo {
  if (!doctor) return { label: '—', tone: 'mut', sub: 'esperando /api/doctor' };
  if (summary.hasChecks) return estadoFromChecks(summary);
  return estadoFromRawFlags(doctor);
}

export default function Dashboard() {
  const {
    data: compare,
    loading,
    error,
    reload,
  } = useResource<PretestCompareData>(() => api.pretestCompare(), { pollMs: 15000 });
  const { data: portfolios } = useResource<PortfoliosResponse>(
    () => api.portfolios() as unknown as Promise<PortfoliosResponse>,
    { pollMs: 15000 },
  );
  const { data: doctor } = useResource<DoctorData>(
    () => api.doctor() as unknown as Promise<DoctorData>,
    { pollMs: 15000 },
  );

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!compare}
      loadingText="Cargando estado…"
    >
      {compare && (
        <DashboardContent
          compare={compare}
          paper={portfolios?.paper ?? null}
          doctor={doctor ?? null}
        />
      )}
    </AsyncBoundary>
  );
}

function DashboardContent({
  compare,
  paper,
  doctor,
}: {
  compare: PretestCompareData;
  paper: PaperPortfolio | null;
  doctor: DoctorData | null;
}) {
  const rows = compare.portfolios;
  const winnerReturn = compare.winner_by_return;

  const checksSummary = summarizeChecks(doctor);
  const { hasChecks, fails, failingNames } = checksSummary;
  const estado = computeEstado(doctor, checksSummary);

  return (
    <div className="space-y-6 animate-[fadeIn_.4s_ease]">
      {/* Salud del sistema */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 stagger">
        <Stat label="Estado del sistema" value={estado.label} tone={estado.tone} sub={estado.sub} />
        <Card className="overflow-hidden relative">
          <CardBody>
            <div className="text-[11px] uppercase tracking-wide text-mut">Carteras activas</div>
            <div className="mt-1 text-2xl font-bold tracking-tight text-info">
              <NumberTicker value={rows.length} />
            </div>
            <div className="mt-1 text-[11px] text-mut leading-snug">
              portfolios compitiendo en pretest
            </div>
          </CardBody>
        </Card>
        <Stat
          label="Líder por retorno"
          value={winnerReturn ? winnerReturn.toUpperCase() : '—'}
          tone="ok"
          sub="entre los que pasan el gate de significancia"
        />
        <Stat
          label="Líder ajustado a riesgo"
          value={compare.winner_by_risk_adj ? compare.winner_by_risk_adj.toUpperCase() : '—'}
          tone="info"
          sub="retorno / max drawdown"
        />
      </div>

      {hasChecks && fails > 0 && (
        <Card className="border-danger/40">
          <CardBody>
            <div className="text-[11px] uppercase tracking-wide text-danger">Chequeos fallando</div>
            <div className="mt-1 text-[13px] text-ink">{failingNames.join(', ')}</div>
          </CardBody>
        </Card>
      )}

      {/* Cartera del kernel (paper) */}
      <Card>
        <CardHeader
          title="Cartera del kernel (paper)"
          hint="El portfolio real que ejecuta el ciclo del agente en modo paper — separado de la competencia de pretest."
        />
        <CardBody>
          {paper ? (
            <div className="grid grid-cols-3 gap-4">
              <Metric label="Equity" value={fmt.money(paper.equity)} />
              <Metric label="Cash" value={fmt.money(paper.cash)} />
              <Metric label="Posiciones abiertas" value={String(paper.positions?.length ?? 0)} />
            </div>
          ) : (
            <p className="text-mut text-[12px] py-2">
              Sin cartera paper todavía — se crea al aplicar la primera estrategia.
            </p>
          )}
        </CardBody>
      </Card>

      {/* Competencia de pretest */}
      <Card>
        <CardHeader
          title="Competencia de portfolios (pretest)"
          icon={<Trophy className="h-4 w-4" />}
          hint="Cada portfolio corre su propia configuración de plugins sobre el mismo universo. El gate de significancia decide quién es elegible a liderar — sin opinión, solo datos."
        />
        <CardBody className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="text-right">Equity</TableHead>
                <TableHead className="text-right">Retorno</TableHead>
                <TableHead className="text-right">maxDD</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Win%</TableHead>
                <TableHead>Gate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => {
                const win = p.name === winnerReturn;
                return (
                  <TableRow key={p.id} className={win ? 'bg-accent/[0.04]' : ''}>
                    <TableCell>
                      <span className="font-semibold text-ink">{p.name}</span>
                      {win && (
                        <span className="ml-2">
                          <Badge tone="ok">líder</Badge>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right num text-ink">{fmt.money(p.equity)}</TableCell>
                    <TableCell
                      className={`text-right num ${p.return_pct >= 0 ? 'text-accent' : 'text-danger'}`}
                    >
                      {fmt.pct(p.return_pct)}
                    </TableCell>
                    <TableCell className="text-right num text-warn">
                      {p.max_drawdown_pct.toFixed(2)}%
                    </TableCell>
                    <TableCell className="text-right num text-mut">{p.total_trades}</TableCell>
                    <TableCell className="text-right num text-mut">
                      {p.win_rate.toFixed(1)}%
                    </TableCell>
                    <TableCell>
                      <Badge tone={p.gate_status === 'READY' ? 'ok' : 'mut'}>
                        {p.gate_status === 'READY' ? 'listo' : 'no listo'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!rows.length && (
            <p className="px-5 py-6 text-[12px] text-mut text-center">
              Sin portfolios de pretest activos todavía.
            </p>
          )}
        </CardBody>
      </Card>

      <NavChart />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-mut">{label}</div>
      <div className="mt-1 text-lg font-bold tracking-tight text-ink num">{value}</div>
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
