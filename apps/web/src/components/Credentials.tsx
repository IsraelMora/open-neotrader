import { useEffect, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import { CircleCheck, X } from 'lucide-react';
import { api } from '../lib/api';

interface Provider {
  env: string;
  label: string;
  estado: string;
  hint: string;
  origen: string;
  grupo: string;
  nota?: string;
}

export default function Credentials() {
  const [provs, setProvs] = useState<Provider[]>([]);
  const [sel, setSel] = useState('');
  const [val, setVal] = useState('');
  const [msg, setMsg] = useState('');
  const load = () =>
    api.credentials().then((d) => setProvs((d as { providers?: Provider[] }).providers || []));
  useEffect(() => {
    load();
  }, []);

  const guardar = async () => {
    if (!sel || !val.trim()) return;
    try {
      await api.setCredential(sel, val.trim());
      setMsg('✓ Credencial guardada en .env');
    } catch {
      setMsg('✗ error');
    }
    setVal('');
    setSel('');
    load();
  };
  const borrar = async (env: string) => {
    if (!confirm('¿Borrar ' + env + '?')) return;
    await api.setCredential(env, '');
    load();
  };

  const configuradas = provs.filter((p) => p.estado === 'configurada');
  const ausentes = provs.filter((p) => p.estado !== 'configurada');

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Añadir credencial"
          hint="Se guarda en .env (0600, fuera de git/backups). Una a la vez."
        />
        <CardBody>
          {msg && <div className="mb-3 text-[12px] text-accent">{msg}</div>}
          <div className="flex gap-2 items-center flex-wrap">
            <Select value={sel} onValueChange={setSel}>
              <SelectTrigger className="min-w-[240px]">
                <SelectValue placeholder="— elige un proveedor —" />
              </SelectTrigger>
              <SelectContent>
                {provs.map((p) => (
                  <SelectItem key={p.env} value={p.env}>
                    {p.label}
                    {p.estado === 'configurada' ? ' (ya configurada)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="password"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && guardar()}
              placeholder="valor de la credencial"
              disabled={!sel}
              className="flex-1 min-w-[200px]"
            />
            <Button onClick={guardar} disabled={!sel || !val.trim()}>
              Guardar
            </Button>
          </div>
          {sel && (
            <p className="mt-2 text-[11px] text-mut">
              {provs.find((p) => p.env === sel)?.nota || ''}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Configuradas (${configuradas.length})`} />
        <CardBody className="space-y-1.5">
          {configuradas.map((p) => (
            <div
              key={p.env}
              className="flex items-center justify-between rounded-md border border-edge/60 px-3 py-2"
            >
              <div>
                <span className="text-[13px] text-ink">{p.label}</span>{' '}
                <span className="text-[11px] text-mut">{p.grupo}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="ok">
                  <CircleCheck className="inline h-3 w-3 -mt-0.5 mr-1" />
                  {p.hint} <span className="opacity-60">({p.origen})</span>
                </Badge>
                <button
                  onClick={() => borrar(p.env)}
                  aria-label="Borrar"
                  className="text-mut hover:text-danger"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {!configuradas.length && (
            <p className="text-mut text-[12px]">Ninguna credencial configurada aún.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Pendientes (${ausentes.length})`}
          hint="Proveedores sin credencial — selecciónalos arriba para añadir."
        />
        <CardBody>
          <div className="flex flex-wrap gap-2">
            {ausentes.map((p) => (
              <Button key={p.env} size="sm" variant="outline" onClick={() => setSel(p.env)}>
                {p.label}
              </Button>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
