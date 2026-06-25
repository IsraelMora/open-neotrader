import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { Trash2, FlaskConical, Radio } from 'lucide-react';

interface Strategy {
  id: string;
  name: string;
  description: string | null;
  config: Record<string, string>;
  active: boolean;
  mode: 'test' | 'live';
}

export default function Strategies() {
  const [items, setItems] = useState<Strategy[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setErr(null);
    api
      .strategies()
      .then((d) => setItems(d as unknown as Strategy[]))
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : 'No se pudieron cargar las estrategias'),
      );
  };
  useEffect(() => {
    load();
  }, []);

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

  const create = () => {
    if (!name.trim()) return;
    void run(async () => {
      // Captura la configuración actual del ciclo como base de la nueva estrategia.
      await api.strategyCreate({ name: name.trim(), description: desc.trim() || undefined });
      setName('');
      setDesc('');
    }, '✓ Estrategia creada desde la configuración actual.');
  };

  if (err)
    return (
      <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
        <div className="font-medium">No se pudieron cargar las estrategias</div>
        <p className="mt-1 text-[12px] opacity-80">{err}</p>
        <button
          onClick={load}
          className="mt-2 rounded border border-danger/40 px-3 py-1 text-[12px] hover:bg-danger/20"
        >
          Reintentar
        </button>
      </div>
    );
  if (!items) return <div className="text-mut text-sm animate-pulse">Cargando estrategias…</div>;

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
          title={`Estrategias (${items.length})`}
          hint="Las activas compiten en paper. Modo test usa datos reales pero no opera (solo mide). 'Aplicar' vuelve esa config la del ciclo global."
        />
        <CardBody className="space-y-2.5">
          {items.length === 0 && (
            <p className="text-[12px] text-mut">
              Aún no hay estrategias. Creá una desde la configuración actual arriba.
            </p>
          )}
          {items.map((s) => (
            <div
              key={s.id}
              className="flex items-start justify-between gap-3 rounded-md border border-edge/60 px-3 py-2.5"
            >
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
                      void run(
                        () =>
                          api.strategyUpdate(s.id, {
                            mode: s.mode === 'live' ? 'test' : 'live',
                          }),
                        s.mode === 'live'
                          ? '✓ Pasada a modo test (no opera).'
                          : '✓ Pasada a modo OPERA (live).',
                      )
                    }
                  >
                    {s.mode === 'live' ? 'pasar a test' : 'pasar a opera'}
                  </button>{' '}
                  ·{' '}
                  <button
                    className="underline hover:text-ink"
                    onClick={() =>
                      void run(() => api.strategyApply(s.id), '✓ Config aplicada al ciclo global.')
                    }
                  >
                    aplicar al ciclo
                  </button>{' '}
                  ·{' '}
                  <button
                    className="underline hover:text-ink"
                    onClick={() =>
                      void run(() => api.strategyPublish(s.id), '✓ Publicada en la tienda.')
                    }
                  >
                    publicar en tienda
                  </button>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={s.active}
                  onCheckedChange={() =>
                    void run(
                      () => api.strategySetActive(s.id, !s.active),
                      s.active ? '✓ Desactivada.' : '✓ Activada (compite).',
                    )
                  }
                />
                <button
                  title="Eliminar"
                  onClick={() =>
                    void run(() => api.strategyDelete(s.id), '✓ Estrategia eliminada.')
                  }
                  className="rounded p-1 text-mut hover:bg-danger/15 hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
