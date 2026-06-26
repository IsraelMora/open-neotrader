import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { AsyncBoundary } from './ui/AsyncBoundary';
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

function ProvidersList({ data, reload }: { data: Provider[]; reload: () => void }) {
  const { busy, run } = useAction();

  const toggle = (p: Provider) =>
    run(() => api.pluginAction(p.id, p.active ? 'deactivate' : 'activate'), {
      success: `${p.name} ${p.active ? 'desactivado' : 'activado'}`,
      onDone: reload,
    });

  return (
    <div className="space-y-5">
      <p className="text-[12px] text-mut">
        Encendé o apagá cada proveedor de datos/ejecución. El modo <strong>paper vs real</strong> NO
        se decide acá: se maneja a nivel de cada estrategia (modo test/opera). Requiere credenciales
        (pestaña Credenciales) para los que las necesiten.
      </p>

      <Card>
        <CardHeader
          title={`Proveedores (${data.length})`}
          hint="Plugins de tipo provider: datos de mercado y ejecución de órdenes."
        />
        <CardBody className="space-y-2.5">
          {data.length === 0 && (
            <p className="text-[12px] text-mut">No hay proveedores instalados.</p>
          )}
          {data.map((p) => (
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

export default function Providers() {
  const { data, loading, error, reload } = useResource<Provider[]>(() =>
    api
      .plugins()
      .then((d) =>
        (((d as { plugins?: Provider[] }).plugins ?? []) as Provider[]).filter(
          (p) => p.type === 'provider',
        ),
      ),
  );

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!data}
      loadingText="Cargando proveedores…"
    >
      {data && <ProvidersList data={data} reload={reload} />}
    </AsyncBoundary>
  );
}
