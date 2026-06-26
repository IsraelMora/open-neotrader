import { useMemo, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import { fmt } from '../lib/utils';
import { fuzzyFilter } from '../lib/fuzzy';
import { SearchInput } from './SearchInput';
import { api } from '../lib/api';
import { useResource } from '../lib/useResource';
import { AsyncBoundary } from './ui/AsyncBoundary';

const PER_PAGE = 50;

interface Trade {
  ts: string;
  cartera: string;
  symbol: string;
  lado: string;
  valor: number;
  precio: number;
  comision: number;
}

interface TradesResponse {
  trades?: Trade[];
}

interface TradesContentProps {
  trades: Trade[];
  filtro: string;
  setFiltro: (v: string) => void;
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  q: string;
  setQ: (v: string) => void;
}

export default function Trades() {
  const { data, loading, error, reload } = useResource<TradesResponse>(
    () => api.trades(2000) as unknown as Promise<TradesResponse>,
  );
  const [filtro, setFiltro] = useState('todas');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');

  return (
    <Card>
      <CardHeader
        title="Histórico de operaciones"
        hint="Todas las órdenes ejecutadas por las carteras, recientes primero."
      />
      <CardBody>
        <AsyncBoundary loading={loading} error={error} onRetry={reload} isEmpty={!data}>
          {data && (
            <TradesContent
              trades={data.trades ?? []}
              filtro={filtro}
              setFiltro={setFiltro}
              page={page}
              setPage={setPage}
              q={q}
              setQ={setQ}
            />
          )}
        </AsyncBoundary>
      </CardBody>
    </Card>
  );
}

function TradesContent({ trades, filtro, setFiltro, page, setPage, q, setQ }: TradesContentProps) {
  const carteras = ['todas', ...Array.from(new Set(trades.map((t) => t.cartera)))];
  const filtradas = useMemo(() => {
    const base = filtro === 'todas' ? trades : trades.filter((t) => t.cartera === filtro);
    return fuzzyFilter(base, q, ['symbol', 'cartera', 'lado']);
  }, [trades, filtro, q]);
  const totalPages = Math.max(1, Math.ceil(filtradas.length / PER_PAGE));
  const pageSafe = Math.min(page, totalPages);
  const slice = filtradas.slice((pageSafe - 1) * PER_PAGE, pageSafe * PER_PAGE);

  return (
    <>
      <div className="mb-3 flex items-center gap-3 flex-wrap">
        <SearchInput value={q} onChange={setQ} placeholder="Buscar símbolo, lado… (difuso)" />
      </div>
      <div className="mb-3 flex gap-2 flex-wrap">
        {carteras.map((c) => (
          <Button
            key={c}
            size="sm"
            variant={filtro === c ? 'default' : 'secondary'}
            onClick={() => {
              setFiltro(c);
              setPage(1);
            }}
          >
            {c}
          </Button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Cartera</TableHead>
              <TableHead>Símbolo</TableHead>
              <TableHead>Lado</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead className="text-right">Precio</TableHead>
              <TableHead className="text-right">Comisión</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {slice.map((t, i) => (
              <TableRow key={i}>
                <TableCell className="num text-mut text-[12px]">{t.ts}</TableCell>
                <TableCell className="text-ink">{t.cartera}</TableCell>
                <TableCell className="num text-ink">{t.symbol}</TableCell>
                <TableCell>
                  <Badge tone={t.lado === 'buy' ? 'ok' : 'danger'}>{t.lado}</Badge>
                </TableCell>
                <TableCell className="text-right num text-ink">{fmt.money(t.valor)}</TableCell>
                <TableCell className="text-right num text-mut">{fmt.money(t.precio)}</TableCell>
                <TableCell className="text-right num text-mut">{fmt.money(t.comision)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!filtradas.length && (
          <p className="text-mut text-sm py-6 text-center">Sin operaciones registradas todavía.</p>
        )}
      </div>
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[12px] text-mut">
            {(pageSafe - 1) * PER_PAGE + 1}–{Math.min(pageSafe * PER_PAGE, filtradas.length)} de{' '}
            {filtradas.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pageSafe <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Anterior
            </Button>
            <span className="text-[12px] text-mut num">
              {pageSafe} / {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={pageSafe >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente →
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
