import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';

interface Provider {
  id: string;
  name: string;
  description?: string;
  active?: boolean;
  type: string;
}

export default function Providers() {
  const [provs, setProvs] = useState<Provider[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setErr(null);
    api
      .plugins()
      .then((d) => {
        const all = d as unknown as Provider[];
        setProvs(all.filter((p) => p.type === 'provider'));
      })
      .catch((e: unknown) =>
        setErr(e instanceof Error ? e.message : 'No se pudieron cargar los proveedores'),
      );
  };
  useEffect(() => {
    load();
  }, []);

  const toggle = async (p: Provider) => {
    setBusy(true);
    try {
      await api.pluginAction(p.id, p.active ? 'deactivate' : 'activate');
      setMsg({ ok: true, t: `✓ ${p.name} ${p.active ? 'desactivado' : 'activado'}` });
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    } finally {
      setBusy(false);
    }
  };

  if (err)
    return (
      <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
        <div className="font-medium">No se pudieron cargar los proveedores</div>
        <p className="mt-1 text-[12px] opacity-80">{err}</p>
        <button
          onClick={load}
          className="mt-2 rounded border border-danger/40 px-3 py-1 text-[12px] hover:bg-danger/20"
        >
          Reintentar
        </button>
      </div>
    );
  if (!provs) return <div className="text-mut text-sm animate-pulse">Cargando proveedores…</div>;

  return (
    <div className="space-y-5">
      {msg && (
        <div
          className={`rounded-md border px-4 py-2.5 text-sm ${msg.ok ? 'border-accent/40 bg-accent/10 text-accent' : 'border-danger/40 bg-danger/10 text-danger'}`}
        >
          {msg.t}
        </div>
      )}
      <p className="text-[12px] text-mut">
        Encendé o apagá cada proveedor de datos/ejecución. El modo <strong>paper vs real</strong> NO
        se decide acá: se maneja a nivel de cada estrategia (modo test/opera). Requiere credenciales
        (pestaña Credenciales) para los que las necesiten.
      </p>

      <Card>
        <CardHeader
          title={`Proveedores (${provs.length})`}
          hint="Plugins de tipo provider: datos de mercado y ejecución de órdenes."
        />
        <CardBody className="space-y-2.5">
          {provs.length === 0 && (
            <p className="text-[12px] text-mut">No hay proveedores instalados.</p>
          )}
          {provs.map((p) => (
            <div
              key={p.id}
              className="flex items-start justify-between gap-3 rounded-md border border-edge/60 px-3 py-2.5"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{p.name}</span>
                  <Badge tone={p.active ? 'ok' : 'mut'}>{p.active ? 'encendido' : 'apagado'}</Badge>
                </div>
                {p.description && (
                  <p className="mt-0.5 text-[12px] leading-snug text-mut">{p.description}</p>
                )}
                <p className="mt-1 text-[11px] text-mut">{p.id}</p>
              </div>
              <Switch
                checked={!!p.active}
                disabled={busy}
                onCheckedChange={() => void toggle(p)}
                aria-label={p.active ? 'Apagar' : 'Encender'}
              />
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
