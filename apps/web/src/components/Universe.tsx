import { useMemo, useState } from 'react';
import { api, type JsonObject } from '../lib/api';
import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { Search, X, Check } from 'lucide-react';
import { fuzzyMatch } from '../lib/fuzzy';
import { SearchInput } from './SearchInput';

// Forma extendida de GET /api/universe/check — `ok`/`velas`/`ultimo_cierre`/`proveedor`
// vienen de una extensión en curso en el backend; degradar con gracia cuando falten
// (p.ej. sólo llega `registered`/`meta`).
interface CheckResult {
  ok?: boolean;
  symbol: string;
  registered?: boolean;
  meta?: Record<string, unknown> | null;
  velas?: number;
  ultimo_cierre?: number;
  proveedor?: string;
  detail?: string;
}

interface ConfigResponse extends JsonObject {
  universe?: Record<string, string>;
  universe_context?: Record<string, string>;
}

// `ok` es la señal fuerte cuando está presente; si falta, nos apoyamos en `registered`
// como aproximación honesta (sin datos de velas todavía no sabemos si el proveedor sirve).
function checkFailed(check: CheckResult): boolean {
  if (check.ok !== undefined) return !check.ok;
  return check.registered === false;
}

/** Descripción legible de las velas/proveedor cuando el backend las incluye (extensión en curso). */
function velasDetail(check: CheckResult): string {
  if (check.velas == null || check.ultimo_cierre == null) return '';
  const proveedor = check.proveedor ? ` (proveedor: ${check.proveedor})` : '';
  return ` · ${check.velas} velas, último cierre $${check.ultimo_cierre}${proveedor}`;
}

interface UniverseContentProps {
  uni: Record<string, string>;
  ctx: Record<string, string>;
  reload: () => void;
}

function UniverseContent({ uni, ctx, reload }: UniverseContentProps) {
  const [sym, setSym] = useState('');
  const [kind, setKind] = useState('equity');
  const [desc, setDesc] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [verBusy, setVerBusy] = useState(false);
  const [q, setQ] = useState('');

  const { busy, run } = useAction();

  const verificar = async () => {
    if (!sym.trim()) return;
    setVerBusy(true);
    setCheck(null);
    try {
      setCheck(
        (await api.universeCheck(encodeURIComponent(sym.trim()), kind)) as unknown as CheckResult,
      );
    } catch {
      setCheck({ ok: false, symbol: sym.trim(), detail: 'error de red' });
    }
    setVerBusy(false);
  };

  const handleAnadir = () =>
    run(
      () =>
        api
          .universeEdit('add', sym.trim().toUpperCase(), kind, desc.trim() || undefined)
          .then(() => {
            setSym('');
            setDesc('');
            setCheck(null);
          }),
      { success: `✓ ${sym.toUpperCase()} añadido al universo`, onDone: reload },
    );

  const handleQuitar = (s: string) => {
    if (!confirm('¿Quitar ' + s + ' del universo?')) return;
    void run(() => api.universeEdit('remove', s), { onDone: reload });
  };

  const filteredEntries = useMemo(
    () => Object.entries(uni).filter(([s]) => fuzzyMatch(s + ' ' + (ctx[s] || ''), q)),
    [uni, ctx, q],
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Añadir activo al universo"
          hint="Cualquier símbolo (acción, ETF, crypto). Se VERIFICA que haya datos antes de añadirlo — evita romper el ciclo."
        />
        <CardBody className="space-y-3">
          <div className="flex gap-2 items-center flex-wrap">
            <Input
              value={sym}
              onChange={(e) => {
                setSym(e.target.value);
                setCheck(null);
              }}
              placeholder="símbolo (AAPL, MSTR, SOL-USD…)"
              className="w-48 font-mono"
            />
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v);
                setCheck(null);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="equity">equity (acción/ETF)</SelectItem>
                <SelectItem value="crypto">crypto (par -USD)</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={verificar} disabled={verBusy || busy || !sym.trim()}>
              <Search className="h-3.5 w-3.5" />
              {verBusy ? 'verificando…' : 'Verificar datos'}
            </Button>
          </div>
          {check && (
            <div
              className={`rounded-md border px-3 py-2 text-[12px] ${checkFailed(check) ? 'border-danger/40 bg-danger/10' : 'border-accent/40 bg-accent/10'}`}
            >
              {checkFailed(check) ? (
                <span className="text-danger inline-flex items-center gap-1.5">
                  <X className="h-3.5 w-3.5" />
                  {check.symbol}: {check.detail ?? 'sin datos'}. No se puede añadir sin datos.
                </span>
              ) : (
                <span className="text-accent inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5" />
                  {check.symbol}
                  {check.registered ? ' · ya registrado en el universo' : ''}
                  {velasDetail(check)}
                </span>
              )}
            </div>
          )}
          {check && !checkFailed(check) && (
            <div className="flex gap-2 items-center">
              <Input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="descripción para el orquestador (opcional)"
                className="flex-1"
              />
              <Button onClick={handleAnadir} disabled={busy}>
                Añadir al universo
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Universo actual (${Object.keys(uni).length} activos)`}
          hint="Todos operan en el ciclo. Quitar uno lo saca también de los sub-universos de proveedores."
        />
        <CardBody>
          <div className="mb-3">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Buscar símbolo o descripción… (difuso)"
            />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Símbolo</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEntries.map(([s, k]) => (
                <TableRow key={s}>
                  <TableCell className="num text-ink font-medium">{s}</TableCell>
                  <TableCell>
                    <Badge tone={k === 'crypto' ? 'warn' : 'info'}>{k}</Badge>
                  </TableCell>
                  <TableCell className="text-[12px] text-mut">{ctx[s] || '—'}</TableCell>
                  <TableCell className="text-right">
                    <button
                      onClick={() => handleQuitar(s)}
                      aria-label="Quitar"
                      className="text-mut hover:text-danger"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}

export default function Universe() {
  const { data, loading, error, reload } = useResource<ConfigResponse>(
    () => api.config() as Promise<ConfigResponse>,
  );

  const uni = data?.universe ?? {};
  const ctx = data?.universe_context ?? {};

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={false}
      loadingText="Cargando universo…"
    >
      {data && <UniverseContent uni={uni} ctx={ctx} reload={reload} />}
    </AsyncBoundary>
  );
}
