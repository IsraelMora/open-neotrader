import { useState } from 'react';
import { api } from '../lib/api';
import { fmt } from '../lib/utils';
import { type Strategy, type Stats } from '../lib/types';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { Trash2, FlaskConical, Radio, Settings2 } from 'lucide-react';
import StrategyDetail from './StrategyDetail';

export default function Strategies() {
  const { data, loading, error, reload } = useResource<Strategy[]>(
    () => api.strategies() as unknown as Promise<Strategy[]>,
  );
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { busy, run } = useAction();

  const loadStats = (id: string) =>
    api
      .strategyStats(id)
      .then((st) => setStats((prev) => ({ ...prev, [id]: st })))
      .catch(() => undefined);

  const handleReload = () => {
    reload();
    if (data) data.forEach((s) => void loadStats(s.id));
  };

  const create = () => {
    if (!name.trim()) return;
    void run(
      async () => {
        await api.strategyCreate({ name: name.trim(), description: desc.trim() || undefined });
        setName('');
        setDesc('');
      },
      { success: '✓ Estrategia creada desde la configuración actual.', onDone: handleReload },
    );
  };

  if (selected)
    return (
      <StrategyDetail
        id={selected}
        onBack={() => {
          setSelected(null);
          handleReload();
        }}
      />
    );

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!data}
      loadingText="Cargando estrategias…"
    >
      {data && (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Nueva estrategia"
              hint="Una estrategia es un perfil nombrado de la configuración del ciclo. Se crea capturando la configuración activa actual; luego la editás y la activás para que compita."
            />
            <CardBody>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nombre (ej. Momentum agresivo)"
                  className="flex-1 rounded-md border border-edge/60 bg-transparent px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/50"
                />
                <input
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Descripción (opcional)"
                  className="flex-1 rounded-md border border-edge/60 bg-transparent px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/50"
                />
                <button
                  onClick={create}
                  disabled={busy || !name.trim()}
                  className="rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-bg disabled:opacity-50"
                >
                  Crear
                </button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Estrategias (${data.length})`}
              hint="Las activas compiten en paper. Modo test usa datos reales pero no opera (solo mide). 'Aplicar' vuelve esa config la del ciclo global."
            />
            <CardBody className="space-y-2.5">
              {data.length === 0 && (
                <p className="text-[12px] text-mut">
                  Aún no hay estrategias. Creá una desde la configuración actual arriba.
                </p>
              )}
              {data.map((s) => (
                <StrategyRow
                  key={s.id}
                  s={s}
                  stat={stats[s.id]}
                  busy={busy}
                  onSelect={setSelected}
                  onRun={run}
                  onReload={handleReload}
                />
              ))}
            </CardBody>
          </Card>
        </div>
      )}
    </AsyncBoundary>
  );
}

function StrategyRow({
  s,
  stat,
  busy,
  onSelect,
  onRun,
  onReload,
}: {
  s: Strategy;
  stat: Stats | undefined;
  busy: boolean;
  onSelect: (id: string) => void;
  onRun: (
    fn: () => Promise<unknown>,
    opts?: { success?: string; onDone?: () => void },
  ) => Promise<boolean>;
  onReload: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-edge/60 px-3 py-2.5">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{s.name}</span>
          <Badge tone={s.mode === 'live' ? 'danger' : 'info'}>
            {s.mode === 'live' ? (
              <Radio className="inline h-3 w-3 -mt-0.5 mr-1" />
            ) : (
              <FlaskConical className="inline h-3 w-3 -mt-0.5 mr-1" />
            )}
            {s.mode === 'live' ? 'opera' : 'test'}
          </Badge>
          {s.active && <Badge tone="ok">activa</Badge>}
        </div>
        {s.description && (
          <p className="mt-0.5 text-[12px] leading-snug text-mut">{s.description}</p>
        )}
        <p className="mt-1 text-[11px] text-mut">
          {Object.keys(s.config).length} parámetros ·{' '}
          <button
            className="underline hover:text-ink"
            onClick={() =>
              void onRun(
                () =>
                  api.strategyUpdate(s.id, {
                    mode: s.mode === 'live' ? 'test' : 'live',
                  }),
                {
                  success:
                    s.mode === 'live'
                      ? '✓ Pasada a modo test (no opera).'
                      : '✓ Pasada a modo OPERA (live).',
                  onDone: onReload,
                },
              )
            }
          >
            {s.mode === 'live' ? 'pasar a test' : 'pasar a opera'}
          </button>{' '}
          ·{' '}
          <button
            className="underline hover:text-ink"
            onClick={() =>
              void onRun(() => api.strategyApply(s.id), {
                success: '✓ Config aplicada al ciclo global.',
                onDone: onReload,
              })
            }
          >
            aplicar al ciclo
          </button>{' '}
          ·{' '}
          <button
            className="underline hover:text-ink"
            onClick={() =>
              void onRun(() => api.strategyPublish(s.id), {
                success: '✓ Publicada en la tienda.',
                onDone: onReload,
              })
            }
          >
            publicar en tienda
          </button>
        </p>
        {stat && stat.n_points > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded bg-edge/40 px-1.5 py-0.5 text-mut">
              NAV <span className="text-ink">{stat.nav}</span>
            </span>
            <span
              className={`rounded px-1.5 py-0.5 ${(stat.return_pct ?? 0) >= 0 ? 'bg-accent/15 text-accent' : 'bg-danger/15 text-danger'}`}
            >
              ret {fmt.pct(stat.return_pct)}
            </span>
            <span className="rounded bg-edge/40 px-1.5 py-0.5 text-mut">
              sharpe <span className="text-ink">{stat.sharpe ?? '—'}</span>
            </span>
            <span className="rounded bg-edge/40 px-1.5 py-0.5 text-mut">
              maxDD <span className="text-ink">{stat.max_drawdown_pct}%</span>
            </span>
            <span className="rounded bg-edge/40 px-1.5 py-0.5 text-mut">{stat.n_points} pts</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          title="Configurar"
          onClick={() => onSelect(s.id)}
          className="rounded p-1 text-mut hover:bg-edge/40 hover:text-ink"
        >
          <Settings2 className="h-4 w-4" />
        </button>
        <Switch
          checked={s.active}
          disabled={busy}
          onCheckedChange={() =>
            void onRun(() => api.strategySetActive(s.id, !s.active), {
              success: s.active ? '✓ Desactivada.' : '✓ Activada (compite).',
              onDone: onReload,
            })
          }
        />
        <button
          title="Eliminar"
          onClick={() =>
            void onRun(() => api.strategyDelete(s.id), {
              success: '✓ Estrategia eliminada.',
              onDone: onReload,
            })
          }
          className="rounded p-1 text-mut hover:bg-danger/15 hover:text-danger"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
