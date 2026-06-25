import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';

interface Strategy {
  id: string;
  name: string;
  description: string | null;
  config: Record<string, string>;
  active: boolean;
  mode: 'test' | 'live';
}
interface Stats {
  n_points: number;
  nav: number | null;
  return_pct: number | null;
  sharpe: number | null;
  max_drawdown_pct: number | null;
}

/** Sub-layout de configuración de UNA estrategia: editar metadatos, params, modo, stats y acciones. */
export default function StrategyDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [s, setS] = useState<Strategy | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // borradores editables
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [cfg, setCfg] = useState<[string, string][]>([]);
  const [newKey, setNewKey] = useState('');

  const load = () => {
    setErr(null);
    api
      .strategyGet(id)
      .then((d) => {
        const st = d as unknown as Strategy;
        setS(st);
        setName(st.name);
        setDesc(st.description ?? '');
        setCfg(Object.entries(st.config));
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Error al cargar'));
    api
      .strategyStats(id)
      .then((d) => setStats(d))
      .catch(() => undefined);
  };
  useEffect(load, [id]);

  const flash = (ok: boolean, t: string) => {
    setMsg({ ok, t });
    setTimeout(() => setMsg(null), 4000);
  };
  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      flash(true, okMsg);
      load();
    } catch (e: unknown) {
      flash(false, '✗ ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setBusy(false);
    }
  };

  const saveMeta = () =>
    void run(
      () => api.strategyUpdate(id, { name: name.trim(), description: desc.trim() }),
      '✓ Guardado.',
    );
  const saveConfig = () => {
    const obj: Record<string, string> = {};
    for (const [k, v] of cfg) if (k.trim()) obj[k.trim()] = v;
    void run(() => api.strategyUpdate(id, { config: obj }), '✓ Configuración guardada.');
  };
  const setMode = (mode: 'test' | 'live') =>
    void run(() => api.strategyUpdate(id, { mode }), `✓ Modo: ${mode}.`);

  const updateCfgValue = (i: number, value: string) =>
    setCfg((prev) => prev.map((row, j): [string, string] => (j === i ? [row[0], value] : row)));
  const removeCfgRow = (i: number) => setCfg((prev) => prev.filter((_, j) => j !== i));
  const addCfgRow = () => {
    if (newKey.trim()) {
      setCfg((prev) => [...prev, [newKey.trim(), '']]);
      setNewKey('');
    }
  };

  if (err)
    return (
      <div className="space-y-3">
        <button onClick={onBack} className="text-[13px] text-mut hover:text-ink">
          <ArrowLeft className="inline h-4 w-4 -mt-0.5 mr-1" />
          Volver
        </button>
        <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {err}
        </div>
      </div>
    );
  if (!s) return <div className="text-mut text-sm animate-pulse">Cargando estrategia…</div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-[13px] text-mut hover:text-ink">
          <ArrowLeft className="inline h-4 w-4 -mt-0.5 mr-1" />
          Volver a estrategias
        </button>
        <div className="flex items-center gap-2">
          <Badge tone={s.mode === 'live' ? 'danger' : 'info'}>
            {s.mode === 'live' ? 'opera' : 'test'}
          </Badge>
          {s.active && <Badge tone="ok">activa</Badge>}
        </div>
      </div>

      {msg && (
        <div
          className={`rounded-md border px-4 py-2.5 text-sm ${msg.ok ? 'border-accent/40 bg-accent/10 text-accent' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {msg.t}
        </div>
      )}

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
              {s.mode === 'live' ? 'Opera (live)' : 'Test'}
            </span>
            <Switch
              checked={s.mode === 'live'}
              disabled={busy}
              onCheckedChange={() => setMode(s.mode === 'live' ? 'test' : 'live')}
              aria-label="Alternar modo"
            />
            <span className="text-[12px] text-mut">
              {s.mode === 'live' ? '⚠ coloca órdenes reales' : 'solo simulación / medición'}
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
                Retorno {stats.return_pct}%
              </span>
              <span>Sharpe {stats.sharpe ?? '—'}</span>
              <span>maxDD {stats.max_drawdown_pct}%</span>
              <span className="text-mut">{stats.n_points} puntos</span>
            </div>
          ) : (
            <p className="text-[12px] text-mut">
              Aún sin datos de NAV. Se acumulan a medida que la estrategia corre ciclos (aplicala al
              ciclo o activala para que compita).
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
              void run(
                () => api.strategySetActive(id, !s.active),
                s.active ? '✓ Desactivada.' : '✓ Activada.',
              )
            }
            disabled={busy}
            className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink hover:bg-edge/30"
          >
            {s.active ? 'Desactivar' : 'Activar (competir)'}
          </button>
          <button
            onClick={() => void run(() => api.strategyApply(id), '✓ Aplicada al ciclo.')}
            disabled={busy}
            className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink hover:bg-edge/30"
          >
            Aplicar al ciclo
          </button>
          <button
            onClick={() => void run(() => api.strategyPublish(id), '✓ Publicada en tienda.')}
            disabled={busy}
            className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink hover:bg-edge/30"
          >
            Publicar en tienda
          </button>
          <button
            onClick={() =>
              void run(async () => {
                await api.strategyDelete(id);
                onBack();
              }, '✓ Eliminada.')
            }
            disabled={busy}
            className="rounded-md border border-danger/40 px-3 py-1.5 text-[13px] text-danger hover:bg-danger/15"
          >
            Eliminar
          </button>
        </CardBody>
      </Card>
    </div>
  );
}
