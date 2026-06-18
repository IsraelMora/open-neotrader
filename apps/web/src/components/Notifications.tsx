import { useEffect, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/button';
import { NumberTicker } from './magic/NumberTicker';
import { CircleX, TriangleAlert, Info, CircleCheck } from 'lucide-react';
import { api } from '../lib/api';

type IconComponent = React.ComponentType<{ className?: string }>;

const ICON: Record<string, IconComponent> = { error: CircleX, aviso: TriangleAlert, info: Info };
const ICON_COLOR: Record<string, string> = {
  error: 'text-danger',
  aviso: 'text-warn',
  info: 'text-info',
};
const TONE: Record<string, string> = { error: 'danger', aviso: 'warn', info: 'info' };

interface NotificationItem {
  nivel: string;
  titulo: string;
  veces: number;
  fuente: string;
  ts?: string;
  detalle: string;
}

interface NotificationsData {
  n_errores: number;
  n_avisos: number;
  items: NotificationItem[];
}

export default function Notifications() {
  const [data, setData] = useState<NotificationsData | null>(null);
  const [filtro, setFiltro] = useState('todos');
  useEffect(() => {
    const load = () =>
      api
        .notifications()
        .then((d) => setData(d as unknown as NotificationsData))
        .catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  if (!data) return <div className="text-mut text-sm animate-pulse">Cargando notificaciones…</div>;

  const items = filtro === 'todos' ? data.items : data.items.filter((i) => i.nivel === filtro);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardBody>
            <div className="text-[11px] uppercase text-mut">Errores</div>
            <div className={`text-2xl font-bold ${data.n_errores ? 'text-danger' : 'text-accent'}`}>
              <NumberTicker value={data.n_errores} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-[11px] uppercase text-mut">Avisos</div>
            <div className={`text-2xl font-bold ${data.n_avisos ? 'text-warn' : 'text-accent'}`}>
              <NumberTicker value={data.n_avisos} />
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
            {['todos', 'error', 'aviso', 'info'].map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filtro === f ? 'default' : 'ghost'}
                onClick={() => setFiltro(f)}
              >
                {f}
              </Button>
            ))}
          </div>
          <div className="space-y-2 max-h-[65vh] overflow-y-auto">
            {items.map((i, idx) => {
              const I: IconComponent = ICON[i.nivel] || Info;
              return (
                <div
                  key={idx}
                  className="flex items-start gap-3 rounded-md border border-edge/60 px-3 py-2"
                >
                  <I className={`h-4 w-4 shrink-0 ${ICON_COLOR[i.nivel] || 'text-mut'}`} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-ink font-medium">{i.titulo}</span>
                      {i.veces > 1 && <span className="text-[11px] text-mut num">×{i.veces}</span>}
                      <Badge tone={TONE[i.nivel]}>{i.fuente}</Badge>
                      {i.ts && <span className="text-[11px] text-mut num">{i.ts}</span>}
                    </div>
                    <p className="text-[12px] text-mut mt-0.5 leading-snug">{i.detalle}</p>
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
