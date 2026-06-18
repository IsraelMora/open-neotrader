import { useEffect, useState } from 'react';
import { api, type JsonObject } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { Lock } from 'lucide-react';

const VER: Record<string, string> = {
  validado: 'ok',
  adoptado: 'ok',
  rechazado: 'danger',
  'no recomendado': 'warn',
};

interface ActivableStrategy {
  id: string;
  nombre: string;
  desc: string;
  activa: boolean;
  on?: unknown;
  off?: unknown;
  toggle: [string, string];
}

interface EvaluatedStrategy {
  veredicto: string;
  nombre: string;
  nota: string;
}

interface StrategiesData {
  base: { nombre: string; desc: string };
  activables: ActivableStrategy[];
  evaluadas: EvaluatedStrategy[];
}

export default function Strategies() {
  const [data, setData] = useState<StrategiesData | null>(null);
  const [cfg, setCfg] = useState<JsonObject | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const load = () => {
    api.strategies().then((d) => setData(d as unknown as StrategiesData));
    api.config().then(setCfg);
  };
  useEffect(() => {
    load();
  }, []);
  if (!data || !cfg)
    return <div className="text-mut text-sm animate-pulse">Cargando estrategias…</div>;

  const toggle = async (a: ActivableStrategy) => {
    const next = structuredClone(cfg) as Record<string, Record<string, unknown>>;
    if (a.on) next[a.toggle[0]][a.toggle[1]] = a.activa ? a.off : a.on;
    else next[a.toggle[0]][a.toggle[1]] = !a.activa;
    try {
      const r = await api.saveConfig(next as JsonObject);
      setCfg((r as { config: JsonObject }).config);
      setMsg({ ok: true, t: '✓ Aplicado desde el próximo ciclo.' });
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    }
  };

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
        <CardHeader title="Núcleo del sistema" hint="Estrategia base, siempre activa." />
        <CardBody>
          <div className="flex items-start gap-3">
            <Badge tone="info">
              <Lock className="inline h-3 w-3 -mt-0.5 mr-1" />
              candado
            </Badge>
            <div>
              <div className="text-[13px] text-ink font-medium">{data.base.nombre}</div>
              <p className="text-[12px] text-mut mt-0.5">{data.base.desc}</p>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Capas activables"
          hint="Modelos que puedes encender/apagar. Aplican desde el próximo ciclo."
        />
        <CardBody className="space-y-2.5">
          {data.activables.map((a) => (
            <div
              key={a.id}
              className="flex items-start justify-between gap-3 rounded-md border border-edge/60 px-3 py-2.5"
            >
              <div className="flex-1">
                <div className="text-[13px] text-ink font-medium">{a.nombre}</div>
                <p className="text-[12px] text-mut mt-0.5 leading-snug">{a.desc}</p>
              </div>
              <Switch checked={a.activa} onCheckedChange={() => toggle(a)} />
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Estrategias evaluadas (historial)"
          hint="Lo que se probó con disciplina anti-overfitting. Las nuevas pasan por journal→backtest→relock."
        />
        <CardBody className="space-y-2">
          {data.evaluadas.map((e, i) => (
            <div key={i} className="flex items-start gap-3 text-[12px]">
              <Badge tone={VER[e.veredicto] || 'mut'}>{e.veredicto}</Badge>
              <div>
                <span className="text-ink">{e.nombre}</span>{' '}
                <span className="text-mut">— {e.nota}</span>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
