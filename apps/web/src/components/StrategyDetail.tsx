import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmt } from '../lib/utils';
import { type Strategy, type Stats } from '../lib/types';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';

/** Sub-layout de configuración de UNA estrategia: editar metadatos, params, modo, stats y acciones. */
export default function StrategyDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const {
    data: strategy,
    loading,
    error,
    reload,
  } = useResource<Strategy>(() => api.strategyGet(id) as unknown as Promise<Strategy>);
  const { data: stats } = useResource<Stats>(() => api.strategyStats(id));
  const { busy, run } = useAction();

  // Editable drafts — initialized from strategy once loaded
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [cfg, setCfg] = useState<[string, string][]>([]);
  const [newKey, setNewKey] = useState('');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (strategy && !initialized) {
      setName(strategy.name);
      setDesc(strategy.description ?? '');
      setCfg(Object.entries(strategy.config));
      setInitialized(true);
    }
  }, [strategy, initialized]);

  // Reset when id changes
  useEffect(() => {
    setInitialized(false);
  }, [id]);

  const handleReload = () => {
    reload();
    setInitialized(false);
  };

  const saveMeta = () =>
    void run(() => api.strategyUpdate(id, { name: name.trim(), description: desc.trim() }), {
      success: '✓ Guardado.',
      onDone: handleReload,
    });

  const saveConfig = () => {
    const obj: Record<string, string> = {};
    for (const [k, v] of cfg) if (k.trim()) obj[k.trim()] = v;
    void run(() => api.strategyUpdate(id, { config: obj }), {
      success: '✓ Configuración guardada.',
      onDone: handleReload,
    });
  };

  const setMode = (mode: 'test' | 'live') =>
    void run(() => api.strategyUpdate(id, { mode }), {
      success: `✓ Modo: ${mode}.`,
      onDone: handleReload,
    });

  const updateCfgValue = (i: number, value: string) =>
    setCfg((prev) => prev.map((row, j): [string, string] => (j === i ? [row[0], value] : row)));

  const removeCfgRow = (i: number) => setCfg((prev) => prev.filter((_, j) => j !== i));

  const addCfgRow = () => {
    if (newKey.trim()) {
      setCfg((prev) => [...prev, [newKey.trim(), '']]);
      setNewKey('');
    }
  };

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!strategy}
      loadingText="Cargando estrategia…"
    >
      {strategy && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <button onClick={onBack} className="text-[13px] text-mut hover:text-ink">
              <ArrowLeft className="inline h-4 w-4 -mt-0.5 mr-1" />
              Volver a estrategias
            </button>
            <div className="flex items-center gap-2">
              <Badge tone={strategy.mode === 'live' ? 'danger' : 'info'}>
                {strategy.mode === 'live' ? 'opera' : 'test'}
              </Badge>
              {strategy.active && <Badge tone="ok">activa</Badge>}
            </div>
          </div>

          {/* ── Metadatos ─────────────────────────────────────────── */}
          <Card>
            <CardHeader title="Identidad" hint="Nombre y descripción de la estrategia." />
            <CardBody className="space-y-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-edge/60 bg-transparent px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/50"
              />
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={2}
                placeholder="Descripción"
                className="w-full rounded-md border border-edge/60 bg-transparent px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/50"
              />
              <button
                onClick={saveMeta}
                disabled={busy}
                className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-bg disabled:opacity-50"
              >
                Guardar
              </button>
            </CardBody>
          </Card>

          {/* ── Modo ──────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Modo"
              hint="Test: usa datos reales pero NO opera (solo mide). Opera: ejecuta de verdad."
            />
            <CardBody>
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-ink">
                  {strategy.mode === 'live' ? 'Opera (live)' : 'Test'}
                </span>
                <Switch
                  checked={strategy.mode === 'live'}
                  disabled={busy}
                  onCheckedChange={() => setMode(strategy.mode === 'live' ? 'test' : 'live')}
                  aria-label="Alternar modo"
                />
                <span className="text-[12px] text-mut">
                  {strategy.mode === 'live'
                    ? '⚠ coloca órdenes reales'
                    : 'solo simulación / medición'}
                </span>
              </div>
            </CardBody>
          </Card>

          {/* ── Parámetros (config bundle) ────────────────────────── */}
          <Card>
            <CardHeader
              title={`Parámetros (${cfg.length})`}
              hint="Las claves de configuración del ciclo que componen esta estrategia."
            />
            <CardBody className="space-y-2">
              {cfg.map(([k, v], i) => (
                <div key={k + i} className="flex items-center gap-2">
                  <span className="w-64 shrink-0 truncate font-mono text-[12px] text-mut" title={k}>
                    {k}
                  </span>
                  <input
                    value={v}
                    onChange={(e) => updateCfgValue(i, e.target.value)}
                    className="flex-1 rounded-md border border-edge/60 bg-transparent px-2 py-1 text-[12px] text-ink outline-none focus:border-accent/50"
                  />
                  <button
                    onClick={() => removeCfgRow(i)}
                    className="rounded p-1 text-mut hover:bg-danger/15 hover:text-danger"
                    title="Quitar"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="nueva.clave (ej. execution.max_position_pct)"
                  className="flex-1 rounded-md border border-edge/60 bg-transparent px-2 py-1 text-[12px] text-ink outline-none focus:border-accent/50"
                />
                <button
                  onClick={addCfgRow}
                  className="rounded-md border border-edge px-2 py-1 text-[12px] text-mut hover:text-ink"
                >
                  <Plus className="inline h-3 w-3 -mt-0.5 mr-1" />
                  Añadir
                </button>
              </div>
              <button
                onClick={saveConfig}
                disabled={busy}
                className="mt-1 rounded-md bg-accent px-4 py-1.5 text-[13px] font-medium text-bg disabled:opacity-50"
              >
                Guardar parámetros
              </button>
            </CardBody>
          </Card>

          {/* ── Rendimiento ───────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Rendimiento"
              hint="Calculado desde los NAV snapshots de esta estrategia."
            />
            <CardBody>
              {stats && stats.n_points > 0 ? (
                <div className="flex flex-wrap gap-3 text-[13px]">
                  <span>
                    NAV <span className="text-ink">{stats.nav}</span>
                  </span>
                  <span className={(stats.return_pct ?? 0) >= 0 ? 'text-accent' : 'text-danger'}>
                    Retorno {fmt.pct(stats.return_pct)}
                  </span>
                  <span>Sharpe {stats.sharpe ?? '—'}</span>
                  <span>maxDD {stats.max_drawdown_pct}%</span>
                  <span className="text-mut">{stats.n_points} puntos</span>
                </div>
              ) : (
                <p className="text-[12px] text-mut">
                  Aún sin datos de NAV. Se acumulan a medida que la estrategia corre ciclos
                  (aplicala al ciclo o activala para que compita).
                </p>
              )}
            </CardBody>
          </Card>

          {/* ── Acciones ──────────────────────────────────────────── */}
          <Card>
            <CardHeader title="Acciones" />
            <CardBody className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  void run(() => api.strategySetActive(id, !strategy.active), {
                    success: strategy.active ? '✓ Desactivada.' : '✓ Activada.',
                    onDone: handleReload,
                  })
                }
                disabled={busy}
                className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink hover:bg-edge/30"
              >
                {strategy.active ? 'Desactivar' : 'Activar (competir)'}
              </button>
              <button
                onClick={() =>
                  void run(() => api.strategyApply(id), {
                    success: '✓ Aplicada al ciclo.',
                    onDone: handleReload,
                  })
                }
                disabled={busy}
                className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink hover:bg-edge/30"
              >
                Aplicar al ciclo
              </button>
              <button
                onClick={() =>
                  void run(() => api.strategyPublish(id), {
                    success: '✓ Publicada en tienda.',
                    onDone: handleReload,
                  })
                }
                disabled={busy}
                className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink hover:bg-edge/30"
              >
                Publicar en tienda
              </button>
              <button
                onClick={() =>
                  void run(
                    async () => {
                      await api.strategyDelete(id);
                      onBack();
                    },
                    { success: '✓ Eliminada.' },
                  )
                }
                disabled={busy}
                className="rounded-md border border-danger/40 px-3 py-1.5 text-[13px] text-danger hover:bg-danger/15"
              >
                Eliminar
              </button>
            </CardBody>
          </Card>
        </div>
      )}
    </AsyncBoundary>
  );
}
