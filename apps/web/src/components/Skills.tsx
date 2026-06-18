import { useEffect, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { fuzzyFilter } from '../lib/fuzzy';
import { SearchInput } from './SearchInput';
import { X, Puzzle } from 'lucide-react';
import { api } from '../lib/api';

interface PluginSkillItem {
  name: string;
  plugin: string;
  key: string;
}

interface LearnedSkillItem {
  name: string;
  description: string;
}

interface SkillsData {
  from_plugins: PluginSkillItem[];
  n_plugins: number;
  learned: LearnedSkillItem[];
}

export default function Skills() {
  const [data, setData] = useState<SkillsData>({ from_plugins: [], n_plugins: 0, learned: [] });
  const [nuevo, setNuevo] = useState({ name: '', description: '' });
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');

  const load = () =>
    api
      .skills()
      .then((d) => setData(d as unknown as SkillsData))
      .catch(() => {});

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!nuevo.name.trim() || !nuevo.description.trim()) return;
    await api.addSkill(nuevo.name, nuevo.description);
    setMsg('✓ Skill añadido');
    setNuevo({ name: '', description: '' });
    load();
  };

  const del = async (name: string) => {
    if (!confirm('¿Eliminar el skill ' + name + '?')) return;
    await api.deleteSkill(name);
    load();
  };

  const PluginSkill = ({ s }: { s: PluginSkillItem }) => (
    <div className="flex items-start gap-3 rounded-md border border-edge/60 px-3 py-2">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink font-medium font-mono">{s.name}</span>
          <Badge tone="info">{s.plugin}</Badge>
        </div>
        <p className="text-[11px] text-mut mt-0.5 font-mono">{s.key}</p>
      </div>
    </div>
  );

  const LearnedSkill = ({ s }: { s: LearnedSkillItem }) => (
    <div className="flex items-start justify-between gap-3 rounded-md border border-edge/60 px-3 py-2">
      <div>
        <span className="text-[13px] text-ink font-medium">{s.name}</span>
        <p className="text-[12px] text-mut mt-0.5 leading-snug">{s.description}</p>
      </div>
      <button
        onClick={() => del(s.name)}
        aria-label="Eliminar"
        className="text-mut hover:text-danger shrink-0 mt-0.5"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const fromPlugins = data.from_plugins ?? [];
  const learned = data.learned ?? [];
  const filtered = fuzzyFilter(fromPlugins, q, ['name', 'plugin', 'key']);
  const filteredLearned = fuzzyFilter(learned, q, ['name', 'description']);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Skills del orquestador"
          hint="El LLM solo puede invocar las funciones declaradas en los plugins activos. No hay skills hardcodeados."
        />
        <CardBody className="space-y-4">
          <SearchInput value={q} onChange={setQ} placeholder="Buscar skill…" />

          <div>
            <div className="text-[11px] uppercase text-mut mb-2">
              De plugins activos ({fromPlugins.length})
            </div>
            {fromPlugins.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-edge/60 px-3 py-4 text-[12px] text-mut">
                <Puzzle className="h-4 w-4 shrink-0" />
                Sin plugins activos — instala un stack desde la tienda y actívalo en la sección
                Plugins.
              </div>
            ) : (
              <div className="space-y-1.5">
                {filtered.map((s, i) => (
                  <PluginSkill key={i} s={s} />
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="text-[11px] uppercase text-mut mb-2">
              Contexto manual ({learned.length})
            </div>
            <div className="space-y-1.5">
              {filteredLearned.map((s, i) => (
                <LearnedSkill key={i} s={s} />
              ))}
            </div>
            {learned.length === 0 && (
              <p className="text-mut text-[12px]">Aún no hay contexto manual.</p>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Añadir contexto manual"
          hint="Conocimiento que tú aportas al orquestador vía texto (cuándo mantener, recortar o vetar)."
        />
        <CardBody>
          {msg && <div className="mb-2 text-[12px] text-accent">{msg}</div>}
          <div className="space-y-2">
            <Input
              value={nuevo.name}
              onChange={(e) => setNuevo({ ...nuevo, name: e.target.value })}
              placeholder="nombre (ej. evitar_earnings_tech)"
            />
            <Textarea
              value={nuevo.description}
              onChange={(e) => setNuevo({ ...nuevo, description: e.target.value })}
              placeholder="cuándo aplica y qué acción recomiendas"
              rows={2}
            />
            <Button onClick={add}>Añadir contexto</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
