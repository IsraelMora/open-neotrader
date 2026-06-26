import { useEffect, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { fuzzyFilter } from '../lib/fuzzy';
import { SearchInput } from './SearchInput';
import { Puzzle } from 'lucide-react';
import { api } from '../lib/api';

interface PluginSkillItem {
  name: string;
  plugin: string;
  key: string;
}

interface SkillsData {
  from_plugins: PluginSkillItem[];
  n_plugins: number;
}

export default function Skills() {
  const [data, setData] = useState<SkillsData>({ from_plugins: [], n_plugins: 0 });
  const [q, setQ] = useState('');

  const load = () =>
    api
      .skills()
      .then((d) => setData(d as unknown as SkillsData))
      .catch(() => {});

  useEffect(() => {
    load();
  }, []);

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

  const fromPlugins = data.from_plugins ?? [];
  const filtered = fuzzyFilter(fromPlugins, q, ['name', 'plugin', 'key']);

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
        </CardBody>
      </Card>
    </div>
  );
}
