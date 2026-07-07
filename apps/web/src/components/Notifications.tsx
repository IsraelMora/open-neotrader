import { useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/button';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { useResource } from '../lib/useResource';
import { NumberTicker } from './magic/NumberTicker';
import { CircleX, TriangleAlert, Info, CircleCheck } from 'lucide-react';
import { api } from '../lib/api';

type IconComponent = React.ComponentType<{ className?: string }>;

// Niveles reales emitidos por el backend (panel.service.ts): 'error' | 'warn'.
// Los plugins pueden escribir otros niveles libres en la clave 'notifications' del config
// (p.ej. 'info') — se soportan mostrando el icono/tono genérico por defecto.
const ICON: Record<string, IconComponent> = { error: CircleX, warn: TriangleAlert, info: Info };
const ICON_COLOR: Record<string, string> = {
  error: 'text-danger',
  warn: 'text-warn',
  info: 'text-info',
};
const TONE: Record<string, string> = { error: 'danger', warn: 'warn', info: 'info' };
// Etiquetas en español para los botones de filtro (las claves de datos quedan en inglés).
const LABEL: Record<string, string> = {
  todos: 'todos',
  error: 'error',
  warn: 'aviso',
  info: 'info',
};

interface NotificationItem {
  level: string;
  title: string;
  source: string;
  body: string;
  ts?: string;
}

interface NotificationsData {
  n_errors: number;
  n_warnings: number;
  items: NotificationItem[];
}

export default function Notifications() {
  const { data, loading, error, reload } = useResource<NotificationsData>(
    () => api.notifications() as unknown as Promise<NotificationsData>,
    { pollMs: 20000 },
  );
  const [filtro, setFiltro] = useState('todos');

  return (
    <AsyncBoundary
      loading={loading}
      error={error}
      onRetry={reload}
      isEmpty={!data}
      loadingText="Cargando notificaciones…"
    >
      {data && <NotificationsContent data={data} filtro={filtro} setFiltro={setFiltro} />}
    </AsyncBoundary>
  );
}

function NotificationsContent({
  data,
  filtro,
  setFiltro,
}: {
  data: NotificationsData;
  filtro: string;
  setFiltro: (f: string) => void;
}) {
  const items = filtro === 'todos' ? data.items : data.items.filter((i) => i.level === filtro);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardBody>
            <div className="text-[11px] uppercase text-mut">Errores</div>
            <div className={`text-2xl font-bold ${data.n_errors ? 'text-danger' : 'text-accent'}`}>
              <NumberTicker value={data.n_errors} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-[11px] uppercase text-mut">Avisos</div>
            <div className={`text-2xl font-bold ${data.n_warnings ? 'text-warn' : 'text-accent'}`}>
              <NumberTicker value={data.n_warnings} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-[11px] uppercase text-mut">Total</div>
            <div className="text-2xl font-bold text-ink">
              <NumberTicker value={data.items.length} />
            </div>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardHeader
          title="Notificaciones del sistema"
          hint="Errores de integridad, alertas de riesgo y degradaciones de datos, priorizados."
        />
        <CardBody>
          <div className="mb-3 flex gap-2">
            {['todos', 'error', 'warn', 'info'].map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filtro === f ? 'default' : 'ghost'}
                onClick={() => setFiltro(f)}
              >
                {LABEL[f]}
              </Button>
            ))}
          </div>
          <div className="space-y-2 max-h-[65vh] overflow-y-auto">
            {items.map((i, idx) => {
              const I: IconComponent = ICON[i.level] || Info;
              return (
                <div
                  key={idx}
                  className="flex items-start gap-3 rounded-md border border-edge/60 px-3 py-2"
                >
                  <I className={`h-4 w-4 shrink-0 ${ICON_COLOR[i.level] || 'text-mut'}`} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-ink font-medium">{i.title}</span>
                      <Badge tone={TONE[i.level]}>{i.source}</Badge>
                      {i.ts && <span className="text-[11px] text-mut num">{i.ts}</span>}
                    </div>
                    <p className="text-[12px] text-mut mt-0.5 leading-snug">{i.body}</p>
                  </div>
                </div>
              );
            })}
            {!items.length && (
              <p className="text-accent text-sm py-6 text-center inline-flex items-center justify-center gap-1.5 w-full">
                <CircleCheck className="h-4 w-4" />
                Sin notificaciones — todo en orden.
              </p>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
