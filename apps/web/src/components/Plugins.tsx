import { useState } from 'react';
import { api, type JsonObject } from '../lib/api';
import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Switch } from './ui/switch';
import { SearchInput } from './SearchInput';
import { fuzzyFilter } from '../lib/fuzzy';
import { Puzzle, Trash2, Plus } from 'lucide-react';

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

interface PluginsResponse extends JsonObject {
  plugins?: Plugin[];
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

function PluginsList({ plugins, reload }: { plugins: Plugin[]; reload: () => void }) {
  const { run: runAction } = useAction();
  const [q, setQ] = useState('');
  const [fuente, setFuente] = useState('');
  const { busy: instalando, run: runInstall } = useAction();

  const togglePlugin = (p: Plugin) =>
    runAction(() => api.pluginAction(p.id, p.active ? 'deactivate' : 'activate'), {
      success: `Plugin ${p.id} ${p.active ? 'desactivado' : 'activado'}`,
      onDone: reload,
    });

  const desinstalar = (p: Plugin) => {
    if (!confirm(`¿Desinstalar el plugin "${p.id}"?`)) return;
    void runAction(() => api.pluginUninstall(p.id), {
      success: `Plugin ${p.id} desinstalado`,
      onDone: reload,
    });
  };

  const instalar = () => {
    if (!fuente.trim()) return;
    void runInstall(() => api.pluginInstall(fuente.trim()), {
      success: 'Plugin instalado correctamente',
      onDone: () => {
        setFuente('');
        reload();
      },
    });
  };

  const guardarConfig = (id: string, vals: JsonObject) =>
    runAction(() => api.pluginConfig(id, vals), {
      success: `Configuración de ${id} guardada`,
      onDone: reload,
    });

  const filtrados = fuzzyFilter(plugins, q, ['id', 'type']);
  const { porTipo, tiposPresentes } = groupByType(filtrados);

  return (
    <div className="space-y-5">
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
                          onCheckedChange={() => void togglePlugin(p)}
                          size="sm"
                          aria-label={p.active ? 'Desactivar' : 'Activar'}
                        />
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
                      <FormConfig plugin={p} onSave={(vals) => void guardarConfig(p.id, vals)} />
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

export default function Plugins() {
  const { data, loading, error, reload } = useResource<Plugin[]>(() =>
    api.plugins().then((r) => (r as PluginsResponse).plugins ?? []),
  );

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={reload} isEmpty={!data}>
      {data && <PluginsList plugins={data} reload={reload} />}
    </AsyncBoundary>
  );
}
