import { useEffect, useMemo, useState } from 'react';
import { api, type JsonObject } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { Search, X, Check } from 'lucide-react';
import { fuzzyMatch } from '../lib/fuzzy';
import { SearchInput } from './SearchInput';

interface CheckResult {
  ok: boolean;
  symbol: string;
  detail?: string;
  velas?: number;
  ultimo_cierre?: number;
  proveedor?: string;
}

interface ConfigResponse extends JsonObject {
  universe?: Record<string, string>;
  universe_context?: Record<string, string>;
}

export default function Universe() {
  const [uni, setUni] = useState<Record<string, string>>({});
  const [ctx, setCtx] = useState<Record<string, string>>({});
  const [sym, setSym] = useState('');
  const [kind, setKind] = useState('equity');
  const [desc, setDesc] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [q, setQ] = useState('');

  const load = () =>
    api.config().then((c) => {
      const cfg = c as ConfigResponse;
      setUni(cfg.universe || {});
      setCtx(cfg.universe_context || {});
    });
  useEffect(() => {
    load();
  }, []);

  const verificar = async () => {
    if (!sym.trim()) return;
    setBusy(true);
    setCheck(null);
    try {
      setCheck(
        (await api.universeCheck(encodeURIComponent(sym.trim()), kind)) as unknown as CheckResult,
      );
    } catch {
      setCheck({ ok: false, symbol: sym.trim(), detail: 'error de red' });
    }
    setBusy(false);
  };

  const añadir = async () => {
    try {
      await api.universeEdit('add', sym.trim().toUpperCase(), kind, desc.trim() || undefined);
      setMsg({ ok: true, t: `✓ ${sym.toUpperCase()} añadido al universo` });
      setSym('');
      setDesc('');
      setCheck(null);
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    }
  };

  const quitar = async (s: string) => {
    if (!confirm('¿Quitar ' + s + ' del universo?')) return;
    await api.universeEdit('remove', s);
    load();
  };

  const filteredEntries = useMemo(
    () => Object.entries(uni).filter(([s]) => fuzzyMatch(s + ' ' + (ctx[s] || ''), q)),
    [uni, ctx, q],
  );

  return (
    <div className="space-y-5">
      {msg && (
        <div
          className={`rounded-md border px-4 py-2.5 text-sm ${msg.ok ? 'border-accent/40 bg-accent/10 text-accent' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {msg.t}
        </div>
      )}

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
            <Button variant="outline" onClick={verificar} disabled={busy || !sym.trim()}>
              <Search className="h-3.5 w-3.5" />
              {busy ? 'verificando…' : 'Verificar datos'}
            </Button>
          </div>
          {check && (
            <div
              className={`rounded-md border px-3 py-2 text-[12px] ${check.ok ? 'border-accent/40 bg-accent/10' : 'border-danger/40 bg-danger/10'}`}
            >
              {check.ok ? (
                <span className="text-accent inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5" />
                  {check.symbol}: {check.velas} velas, último cierre ${check.ultimo_cierre}{' '}
                  (proveedor: {check.proveedor})
                </span>
              ) : (
                <span className="text-danger inline-flex items-center gap-1.5">
                  <X className="h-3.5 w-3.5" />
                  {check.symbol}: {check.detail}. No se puede añadir sin datos.
                </span>
              )}
            </div>
          )}
          {check?.ok && (
            <div className="flex gap-2 items-center">
              <Input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="descripción para el orquestador (opcional)"
                className="flex-1"
              />
              <Button onClick={añadir}>Añadir al universo</Button>
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
                      onClick={() => quitar(s)}
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
