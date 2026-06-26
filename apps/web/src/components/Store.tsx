import { useState } from 'react';
import { api, type JsonObject } from '../lib/api';
import { useResource } from '../lib/useResource';
import { useAction } from '../lib/useAction';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Badge } from './ui/Badge';
import { SearchInput } from './SearchInput';
import { Store as StoreIcon, Download, ThumbsUp, ThumbsDown, Flag } from 'lucide-react';

const TIPO_TONE: Record<string, string> = {
  universe: 'info',
  skill: 'ok',
  preset: 'warn',
  'discipline-profile': 'mut',
};

const TIPOS = ['', 'universe', 'skill', 'preset', 'discipline-profile'];

interface StoreItem {
  id?: string;
  manifestId?: string;
  publisherId?: string;
  name?: string;
  type?: string;
  latestVersion?: string;
  version?: string;
  publisherName?: string;
  description?: string;
  likes?: number;
  dislikes?: number;
}

interface IdentityData extends JsonObject {
  publisher_id: string;
  display_name: string | null;
}

interface BrowseResponse extends JsonObject {
  items?: StoreItem[];
}

async function saveDisplayName(name: string, reload: () => void): Promise<void> {
  await api.storeSetName(name || null);
  reload();
}

function IdentityCard() {
  const {
    data: identity,
    loading,
    error,
    reload,
  } = useResource<IdentityData>(() => api.storeIdentity().then((r) => r as IdentityData));
  const { busy: guardandoNombre, run } = useAction();
  const [displayName, setDisplayName] = useState('');

  if (identity && displayName === '' && identity.display_name) {
    setDisplayName(identity.display_name);
  }

  const guardarNombre = () =>
    run(() => saveDisplayName(displayName.trim(), reload), {
      success: 'Nombre de publicador guardado',
    });

  return (
    <Card>
      <CardHeader
        title="Identidad de publicador"
        icon={<StoreIcon className="h-4 w-4" />}
        hint="Tu identidad en la tienda comunitaria. Opt-in: añade un nombre visible para que otros reconozcan tus plugins."
      />
      <CardBody className="space-y-3">
        <AsyncBoundary
          loading={loading}
          error={error}
          onRetry={reload}
          isEmpty={!identity}
          loadingText="Cargando identidad…"
          emptyText="Tienda no disponible (error 502). La tienda comunitaria puede estar temporalmente inaccesible."
        >
          {identity && (
            <IdentityForm
              identity={identity}
              displayName={displayName}
              setDisplayName={setDisplayName}
              guardarNombre={guardarNombre}
              guardandoNombre={guardandoNombre}
            />
          )}
        </AsyncBoundary>
      </CardBody>
    </Card>
  );
}

function IdentityForm({
  identity,
  displayName,
  setDisplayName,
  guardarNombre,
  guardandoNombre,
}: {
  identity: IdentityData;
  displayName: string;
  setDisplayName: (v: string) => void;
  guardarNombre: () => Promise<boolean>;
  guardandoNombre: boolean;
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-mut">ID publicador:</span>
        <code className="font-mono text-[12px] text-ink bg-edge/30 px-1.5 py-0.5 rounded truncate max-w-xs">
          {identity.publisher_id}
        </code>
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Nombre visible (opcional)"
          className="flex-1 min-w-0 rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent/50 max-w-xs"
        />
        <button
          onClick={() => void guardarNombre()}
          disabled={guardandoNombre}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent/90 px-4 py-1.5 text-sm font-medium text-bg hover:bg-accent disabled:opacity-40"
        >
          {guardandoNombre ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </>
  );
}

function CatalogCard() {
  const [q, setQ] = useState('');
  const [tipo, setTipo] = useState('');
  const [ocupado, setOcupado] = useState<Record<string, boolean>>({});
  const { run } = useAction();

  const { data, loading, error, reload } = useResource<StoreItem[]>(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (tipo) params.set('type', tipo);
    return api.storeBrowse(params.toString()).then((r) => (r as BrowseResponse).items ?? []);
  });

  const setBusy = (key: string, val: boolean) => setOcupado((o) => ({ ...o, [key]: val }));

  const instalar = async (item: StoreItem) => {
    const key = item.manifestId ?? item.id ?? '';
    setBusy(key, true);
    await run(
      () =>
        api.storeInstall(
          item.publisherId ?? '',
          item.manifestId ?? '',
          item.latestVersion ?? item.version ?? '',
        ),
      { success: `Plugin "${item.name ?? item.manifestId}" instalado` },
    );
    setBusy(key, false);
  };

  const votar = async (item: StoreItem, kind: 'like' | 'dislike') => {
    const key = (item.manifestId ?? item.id ?? '') + kind;
    setBusy(key, true);
    await run(() => api.storeVote(item.id ?? item.manifestId ?? '', kind), {
      success: 'Voto registrado',
      onDone: reload,
    });
    setBusy(key, false);
  };

  const reportar = async (item: StoreItem) => {
    const motivo = prompt('Motivo del reporte (obligatorio):');
    if (!motivo?.trim()) return;
    const key = (item.manifestId ?? item.id ?? '') + 'report';
    setBusy(key, true);
    await run(() => api.storeReport(item.id ?? item.manifestId ?? '', motivo.trim()), {
      success: 'Reporte enviado',
    });
    setBusy(key, false);
  };

  return (
    <Card>
      <CardHeader
        title="Tienda"
        icon={<StoreIcon className="h-4 w-4" />}
        hint="Explora, instala y comparte plugins de la comunidad. Uso bajo tu propio riesgo."
      />
      <CardBody className="space-y-4">
        <div className="flex gap-2 items-center flex-wrap">
          <SearchInput value={q} onChange={setQ} placeholder="Buscar plugins…" />
          <select
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            className="rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent/50"
          >
            {TIPOS.map((t) => (
              <option key={t} value={t}>
                {t || 'Todos los tipos'}
              </option>
            ))}
          </select>
        </div>

        <AsyncBoundary
          loading={loading}
          error={error}
          onRetry={reload}
          isEmpty={!data?.length}
          emptyText="No se encontraron plugins con esos criterios."
        >
          {data && data.length > 0 && (
            <StoreItemList
              items={data}
              ocupado={ocupado}
              instalar={instalar}
              votar={votar}
              reportar={reportar}
            />
          )}
        </AsyncBoundary>
      </CardBody>
    </Card>
  );
}

function StoreItemList({
  items,
  ocupado,
  instalar,
  votar,
  reportar,
}: {
  items: StoreItem[];
  ocupado: Record<string, boolean>;
  instalar: (item: StoreItem) => Promise<void>;
  votar: (item: StoreItem, kind: 'like' | 'dislike') => Promise<void>;
  reportar: (item: StoreItem) => Promise<void>;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => {
        const key = item.manifestId ?? item.id ?? '';
        const likeBusy = ocupado[key + 'like'];
        const dislikeBusy = ocupado[key + 'dislike'];
        const reportBusy = ocupado[key + 'report'];
        const installBusy = ocupado[key];
        return (
          <div key={key} className="rounded-md border border-edge/60 px-3 py-2.5 space-y-1.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <span className="text-[13px] text-ink font-medium truncate">
                  {item.name ?? item.manifestId}
                </span>
                {item.type && <Badge tone={TIPO_TONE[item.type] ?? 'mut'}>{item.type}</Badge>}
                {item.latestVersion && (
                  <span className="text-[11px] text-mut num shrink-0">v{item.latestVersion}</span>
                )}
                {item.publisherName && (
                  <span className="text-[11px] text-mut shrink-0">por {item.publisherName}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                {item.likes != null && (
                  <span className="text-[11px] text-mut num">{item.likes} 👍</span>
                )}
                {item.dislikes != null && (
                  <span className="text-[11px] text-mut num">{item.dislikes} 👎</span>
                )}
                <button
                  onClick={() => void votar(item, 'like')}
                  disabled={!!likeBusy}
                  title="Me gusta"
                  className="text-mut hover:text-accent disabled:opacity-40"
                >
                  <ThumbsUp className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void votar(item, 'dislike')}
                  disabled={!!dislikeBusy}
                  title="No me gusta"
                  className="text-mut hover:text-danger disabled:opacity-40"
                >
                  <ThumbsDown className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void reportar(item)}
                  disabled={!!reportBusy}
                  title="Reportar"
                  className="text-mut hover:text-warn disabled:opacity-40"
                >
                  <Flag className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void instalar(item)}
                  disabled={!!installBusy}
                  className="inline-flex items-center gap-1 rounded-md bg-accent/90 px-2.5 py-1 text-[12px] font-medium text-bg hover:bg-accent disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" />
                  {installBusy ? 'Instalando…' : 'Instalar'}
                </button>
              </div>
            </div>
            {item.description && <p className="text-[12px] text-mut">{item.description}</p>}
          </div>
        );
      })}
    </div>
  );
}

export default function Store() {
  return (
    <div className="space-y-5">
      <IdentityCard />
      <CatalogCard />
    </div>
  );
}
