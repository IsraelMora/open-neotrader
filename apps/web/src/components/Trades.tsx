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
  mostrarHolds: boolean;
  setMostrarHolds: (v: boolean) => void;
}

export default function Trades() {
  const { data, loading, error, reload } = useResource<TradesResponse>(
    () => api.trades(2000) as unknown as Promise<TradesResponse>,
  );
  const [filtro, setFiltro] = useState('todos');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [mostrarHolds, setMostrarHolds] = useState(false);

  return (
    <Card>
      <CardHeader
        title="Histórico de operaciones"
        hint="Todas las órdenes ejecutadas, recientes primero. Los holds (valor $0) están ocultos por defecto."
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
              mostrarHolds={mostrarHolds}
              setMostrarHolds={setMostrarHolds}
            />
          )}
        </AsyncBoundary>
      </CardBody>
    </Card>
  );
}

function TradesContent({
  trades,
  filtro,
  setFiltro,
  page,
  setPage,
  q,
  setQ,
  mostrarHolds,
  setMostrarHolds,
}: TradesContentProps) {
  // `cartera` es en realidad el MODO de ejecución (paper|live), no una cartera distinta.
  const modos = ['todos', ...Array.from(new Set(trades.map((t) => t.cartera)))];
  const filtradas = useMemo(() => {
    let base = filtro === 'todos' ? trades : trades.filter((t) => t.cartera === filtro);
    if (!mostrarHolds) base = base.filter((t) => t.lado !== 'hold');
    return fuzzyFilter(base, q, ['symbol', 'cartera', 'lado']);
  }, [trades, filtro, q, mostrarHolds]);
  const totalPages = Math.max(1, Math.ceil(filtradas.length / PER_PAGE));
  const pageSafe = Math.min(page, totalPages);
  const slice = filtradas.slice((pageSafe - 1) * PER_PAGE, pageSafe * PER_PAGE);

  return (
    <>
      <div className="mb-3 flex items-center gap-3 flex-wrap">
        <SearchInput value={q} onChange={setQ} placeholder="Buscar símbolo, lado… (difuso)" />
      </div>
      <div className="mb-3 flex gap-2 flex-wrap items-center">
        {modos.map((m) => (
          <Button
            key={m}
            size="sm"
            variant={filtro === m ? 'default' : 'secondary'}
            onClick={() => {
              setFiltro(m);
              setPage(1);
            }}
          >
            {m}
          </Button>
        ))}
        <span className="w-px h-5 bg-edge/60 mx-1" />
        <Button
          size="sm"
          variant={mostrarHolds ? 'default' : 'outline'}
          onClick={() => {
            setMostrarHolds(!mostrarHolds);
            setPage(1);
          }}
        >
          mostrar holds
        </Button>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Modo</TableHead>
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
