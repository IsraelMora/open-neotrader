import { useEffect, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Button } from './ui/button';
import { fuzzyMatch } from '../lib/fuzzy';
import { SearchInput } from './SearchInput';
import { CircleX, TriangleAlert, CircleCheck, Info } from 'lucide-react';
import { api } from '../lib/api';

const STREAMS = [
  'agent_cycles',
  'alerts',
  'nav',
  'alpaca_orders',
  'binance_orders',
  'data_degradation',
];

type Nivel = 'error' | 'warn' | 'ok' | 'trace';

interface LogEntry {
  timestamp?: string;
  severity?: string;
  alerts?: Array<{ severity?: string }>;
  phase?: string;
  status?: string;
  n_alerts?: number;
  data?: { alerts?: number };
  [key: string]: unknown;
}

// Clasifica una entrada por severidad mirando sus campos reales (phase,
// severity, status, type) + palabras clave. Heurística, no inventa datos.
function nivelLog(e: LogEntry): Nivel {
  const s = JSON.stringify(e).toLowerCase();
  const sev = String(e?.severity || e?.alerts?.[0]?.severity || '').toUpperCase();
  const phase = String(e?.phase || '').toLowerCase();
  const status = String(e?.status || '').toLowerCase();

  if (
    sev === 'CRITICAL' ||
    /\b(error|failed|fail|abort|exception|traceback|rejected|canceled|cancelled)\b/.test(s) ||
    ['failed', 'error', 'aborted'].includes(phase) ||
    ['rejected', 'canceled', 'cancelled'].includes(status)
  )
    return 'error';
  if (
    sev === 'HIGH' ||
    sev === 'MEDIUM' ||
    sev === 'WARN' ||
    sev === 'LOW' ||
    /\b(warn|degrad|alerta|cautela|flash_move|spike)\b/.test(s) ||
    (typeof e?.n_alerts === 'number' && e.n_alerts > 0) ||
    (typeof e?.data?.alerts === 'number' && e.data.alerts > 0) ||
    status.includes('pending')
  )
    return 'warn';
  if (
    ['executed', 'ok', 'done', 'success'].includes(phase) ||
    ['filled', 'accepted', 'new'].includes(status) ||
    /\b(adoptad|filled|success|ok)\b/.test(s)
  )
    return 'ok';
  return 'trace';
}

type EstiloEntry = {
  borde: string;
  texto: string;
  chip: string;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
};

const ESTILO: Record<Nivel, EstiloEntry> = {
  error: {
    borde: 'border-l-danger',
    texto: 'text-danger',
    chip: 'bg-danger/15 text-danger',
    Icon: CircleX,
    label: 'error',
  },
  warn: {
    borde: 'border-l-warn',
    texto: 'text-warn',
    chip: 'bg-warn/15 text-warn',
    Icon: TriangleAlert,
    label: 'aviso',
  },
  ok: {
    borde: 'border-l-accent',
    texto: 'text-accent',
    chip: 'bg-accent/15 text-accent',
    Icon: CircleCheck,
    label: 'ok',
  },
  trace: {
    borde: 'border-l-edge',
    texto: 'text-mut',
    chip: 'bg-edge/50 text-mut',
    Icon: Info,
    label: 'traza',
  },
};

interface LogsResponse {
  entries?: LogEntry[];
}

export default function Logs() {
  const [stream, setStream] = useState('agent_cycles');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [q, setQ] = useState('');
  const [filtro, setFiltro] = useState<Nivel | 'all'>('all');

  useEffect(() => {
    api
      .logs(stream, 100)
      .then((d) => setEntries(((d as LogsResponse).entries || []).slice().reverse()))
      .catch(() => setEntries([]));
  }, [stream]);

  const visibles = entries
    .filter((e) => fuzzyMatch(JSON.stringify(e), q))
    .filter((e) => filtro === 'all' || nivelLog(e) === filtro);

  // Conteo por nivel (sobre el stream actual) para los filtros.
  const conteo = entries.reduce(
    (a, e) => {
      const n = nivelLog(e);
      a[n] = (a[n] || 0) + 1;
      return a;
    },
    {} as Record<Nivel, number>,
  );

  return (
    <Card>
      <CardHeader
        title="Logs del sistema"
        hint="Eventos del agente por stream. Color por severidad: error · aviso · ok · traza."
      />
      <CardBody>
        <div className="mb-3 flex gap-2 flex-wrap">
          {STREAMS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={stream === s ? 'default' : 'ghost'}
              className="font-mono text-[12px]"
              onClick={() => setStream(s)}
            >
              {s}
            </Button>
          ))}
        </div>

        <div className="mb-3 flex gap-2 flex-wrap items-center">
          <Button
            size="sm"
            variant={filtro === 'all' ? 'secondary' : 'ghost'}
            onClick={() => setFiltro('all')}
          >
            todos ({entries.length})
          </Button>
          {(['error', 'warn', 'ok', 'trace'] as Nivel[]).map((n) => {
            const st = ESTILO[n];
            return (
              <Button
                key={n}
                size="sm"
                variant={filtro === n ? 'secondary' : 'ghost'}
                onClick={() => setFiltro(filtro === n ? 'all' : n)}
              >
                <st.Icon className="h-3 w-3" />
                {st.label} ({conteo[n] || 0})
              </Button>
            );
          })}
        </div>

        <div className="mb-3">
          <SearchInput value={q} onChange={setQ} placeholder="Buscar en los logs… (difuso)" />
        </div>

        <div className="max-h-[60vh] overflow-y-auto space-y-1.5">
          {visibles.map((e, i) => {
            const n = nivelLog(e);
            const st = ESTILO[n];
            const { timestamp, ...resto } = e;
            return (
              <div
                key={i}
                className={`rounded-r border-l-2 ${st.borde} bg-edge/15 pl-2.5 pr-2 py-1.5`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${st.chip}`}
                  >
                    <st.Icon className="h-3 w-3" />
                    {st.label}
                  </span>
                  {timestamp && <span className="text-[10px] text-mut num">{timestamp}</span>}
                </div>
                <pre
                  className={`text-[11px] num whitespace-pre-wrap break-all ${st.texto} opacity-90`}
                >
                  {JSON.stringify(resto)}
                </pre>
              </div>
            );
          })}
          {!visibles.length && (
            <p className="text-mut text-sm py-6 text-center">
              {entries.length
                ? 'Sin coincidencias con el filtro/búsqueda.'
                : `Sin entradas en «${stream}».`}
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
