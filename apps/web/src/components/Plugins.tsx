import { useEffect, useState } from 'react';
import { api, type JsonObject } from '../lib/api';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { SearchInput } from './SearchInput';
import { fuzzyFilter } from '../lib/fuzzy';
import { Puzzle, Trash2, Plus, Share2 } from 'lucide-react';

const TIPO_TONE: Record<string, string> = {
  universe: 'info',
  skill: 'ok',
  preset: 'warn',
  'discipline-profile': 'mut',
};

interface FieldSpec {
  key: string;
  label?: string;
  type?: string;
  default?: string | number | boolean;
  options?: string[];
}

interface ConfigSpec {
  form?: { fields?: FieldSpec[] };
}

interface Plugin {
  id: string;
  type?: string;
  version?: string;
  active?: boolean;
  config_spec?: ConfigSpec;
}

function FieldInput({
  f,
  vals,
  setVals,
}: {
  f: FieldSpec;
  vals: JsonObject;
  setVals: (v: JsonObject) => void;
}) {
  if (f.type === 'bool') {
    return (
      <Switch
        checked={!!vals[f.key]}
        onCheckedChange={(v) => setVals({ ...vals, [f.key]: v })}
        size="sm"
      />
    );
  }
  if (f.type === 'select') {
    return (
      <select
        value={String(vals[f.key])}
        onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
        className="rounded-md border border-edge bg-bg px-2 py-1 text-sm text-ink outline-none focus:border-accent/50"
      >
        {(f.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={f.type === 'number' ? 'number' : 'text'}
      value={String(vals[f.key])}
      onChange={(e) =>
        setVals({
          ...vals,
          [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value,
        })
      }
      className="rounded-md border border-edge bg-bg px-2.5 py-1 text-sm text-ink outline-none focus:border-accent/50 w-48"
    />
  );
}

function FormConfig({
  plugin,
  onSave,
}: {
  plugin: Plugin;
  onSave: (vals: JsonObject) => void;
}): React.ReactElement | null {
  const fields: FieldSpec[] = plugin.config_spec?.form?.fields ?? [];
  const [vals, setVals] = useState<JsonObject>(() => {
    const init: JsonObject = {};
    for (const f of fields) init[f.key] = f.default ?? '';
    return init;
  });
  if (!fields.length) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-edge/40 pt-3">
      <div className="text-[11px] uppercase text-mut mb-1">Configuración</div>
      {fields.map((f) => (
        <div key={f.key} className="flex items-center gap-2">
          <label className="text-[12px] text-mut w-32 shrink-0">{f.label ?? f.key}</label>
          <FieldInput f={f} vals={vals} setVals={setVals} />
        </div>
      ))}
      <button
        onClick={() => onSave(vals)}
        className="rounded-md bg-accent/90 px-3 py-1.5 text-sm font-medium text-bg hover:bg-accent"
      >
        Guardar
      </button>
    </div>
  );
}

interface PluginsResponse extends JsonObject {
  plugins?: Plugin[];
}

function groupByType(filtrados: Plugin[]): {
  porTipo: Record<string, Plugin[]>;
  tiposPresentes: string[];
} {
  const grupos = ['universe', 'skill', 'preset', 'discipline-profile'];
  const porTipo: Record<string, Plugin[]> = {};
  for (const p of filtrados) {
    const t = p.type ?? 'other';
    if (!porTipo[t]) porTipo[t] = [];
    porTipo[t].push(p);
  }
  const tiposPresentes = [
    ...grupos.filter((g) => porTipo[g]?.length),
    ...Object.keys(porTipo).filter((t) => !grupos.includes(t) && porTipo[t]?.length),
  ];
  return { porTipo, tiposPresentes };
}

export default function Plugins() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [q, setQ] = useState('');
  const [fuente, setFuente] = useState('');
  const [instalando, setInstalando] = useState(false);
  const [publicando, setPublicando] = useState<Record<string, boolean>>({});

  const load = () =>
    api
      .plugins()
      .then((r) => setPlugins((r as PluginsResponse).plugins ?? []))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const togglePlugin = async (p: Plugin) => {
    try {
      await api.pluginAction(p.id, p.active ? 'deactivate' : 'activate');
      setMsg({ ok: true, t: `✓ Plugin ${p.id} ${p.active ? 'desactivado' : 'activado'}` });
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    }
  };

  const desinstalar = async (p: Plugin) => {
    if (!confirm(`¿Desinstalar el plugin "${p.id}"?`)) return;
    try {
      await api.pluginUninstall(p.id);
      setMsg({ ok: true, t: `✓ Plugin ${p.id} desinstalado` });
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    }
  };

  const instalar = async () => {
    if (!fuente.trim()) return;
    setInstalando(true);
    setMsg(null);
    try {
      await api.pluginInstall(fuente.trim());
      setMsg({ ok: true, t: '✓ Plugin instalado correctamente' });
      setFuente('');
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    } finally {
      setInstalando(false);
    }
  };

  const publicarEnTienda = async (p: Plugin) => {
    setPublicando((prev) => ({ ...prev, [p.id]: true }));
    setMsg(null);
    try {
      await api.storePublish(p.id);
      setMsg({ ok: true, t: `✓ Plugin "${p.id}" publicado en la tienda` });
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    } finally {
      setPublicando((prev) => ({ ...prev, [p.id]: false }));
    }
  };

  const guardarConfig = async (id: string, vals: JsonObject) => {
    try {
      await api.pluginConfig(id, vals);
      setMsg({ ok: true, t: `✓ Configuración de ${id} guardada` });
      load();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    }
  };

  const filtrados = fuzzyFilter(plugins, q, ['id', 'type']);
  const { porTipo, tiposPresentes } = groupByType(filtrados);

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
          title="Plugins"
          icon={<Puzzle className="h-4 w-4" />}
          hint="Instala, activa y configura plugins (skills, universos, presets, perfiles de disciplina)."
        />
        <CardBody className="space-y-4">
          <SearchInput value={q} onChange={setQ} placeholder="Buscar plugin… (difuso)" />

          {plugins.length === 0 && (
            <p className="text-mut text-[12px]">No hay plugins instalados.</p>
          )}

          {tiposPresentes.map((tipo) => (
            <div key={tipo}>
              <div className="text-[11px] uppercase text-mut mb-2">
                {tipo} ({porTipo[tipo].length})
              </div>
              <div className="space-y-1.5">
                {porTipo[tipo].map((p) => (
                  <div key={p.id} className="rounded-md border border-edge/60 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] text-ink font-medium truncate">{p.id}</span>
                        <Badge tone={TIPO_TONE[p.type ?? ''] ?? 'mut'}>{p.type ?? '—'}</Badge>
                        {p.version && (
                          <span className="text-[11px] text-mut num shrink-0">v{p.version}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={!!p.active}
                          onCheckedChange={() => togglePlugin(p)}
                          size="sm"
                          aria-label={p.active ? 'Desactivar' : 'Activar'}
                        />
                        <button
                          onClick={() => publicarEnTienda(p)}
                          disabled={!!publicando[p.id]}
                          aria-label="Publicar en la tienda"
                          title="Publicar en la tienda"
                          className="text-mut hover:text-accent disabled:opacity-40"
                        >
                          <Share2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => desinstalar(p)}
                          aria-label="Desinstalar"
                          className="text-mut hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    {p.config_spec?.form && (
                      <FormConfig plugin={p} onSave={(vals) => guardarConfig(p.id, vals)} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Instalar plugin"
          hint="Ruta local a la carpeta del plugin (debe contener manifest.json válido)."
        />
        <CardBody>
          <div className="flex gap-2 items-center flex-wrap">
            <input
              value={fuente}
              onChange={(e) => setFuente(e.target.value)}
              placeholder="/ruta/al/plugin o nombre@version"
              className="flex-1 min-w-0 rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent/50"
            />
            <button
              onClick={instalar}
              disabled={instalando || !fuente.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent/90 px-4 py-1.5 text-sm font-medium text-bg hover:bg-accent disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
              {instalando ? 'Instalando…' : 'Instalar'}
            </button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
