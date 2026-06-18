import { useEffect, useState } from 'react';
import { api, type JsonObject } from '../lib/api';
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

function IdentityContent({
  identityError,
  identity,
  displayName,
  setDisplayName,
  guardarNombre,
  guardandoNombre,
}: {
  identityError: boolean;
  identity: IdentityData | null;
  displayName: string;
  setDisplayName: (v: string) => void;
  guardarNombre: () => void;
  guardandoNombre: boolean;
}) {
  if (identityError) {
    return (
      <p className="text-[12px] text-danger">
        Tienda no disponible (error 502). La tienda comunitaria puede estar temporalmente
        inaccesible.
      </p>
    );
  }
  if (!identity) {
    return <p className="text-[12px] text-mut">Cargando identidad…</p>;
  }
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
          onClick={guardarNombre}
          disabled={guardandoNombre}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent/90 px-4 py-1.5 text-sm font-medium text-bg hover:bg-accent disabled:opacity-40"
        >
          {guardandoNombre ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </>
  );
}

export default function Store() {
  const [identity, setIdentity] = useState<IdentityData | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [guardandoNombre, setGuardandoNombre] = useState(false);

  const [items, setItems] = useState<StoreItem[]>([]);
  const [storeError, setStoreError] = useState(false);
  const [cargando, setCargando] = useState(false);

  const [q, setQ] = useState('');
  const [tipo, setTipo] = useState('');

  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [ocupado, setOcupado] = useState<Record<string, boolean>>({});

  // Carga identidad al montar
  useEffect(() => {
    api
      .storeIdentity()
      .then((r) => {
        const data = r as IdentityData;
        setIdentity(data);
        setDisplayName(data.display_name ?? '');
        setIdentityError(false);
      })
      .catch(() => setIdentityError(true));
  }, []);

  // Carga resultados de búsqueda
  const buscar = () => {
    setCargando(true);
    setStoreError(false);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (tipo) params.set('type', tipo);
    api
      .storeBrowse(params.toString())
      .then((r) => {
        setItems((r as BrowseResponse).items ?? []);
        setStoreError(false);
      })
      .catch(() => {
        setItems([]);
        setStoreError(true);
      })
      .finally(() => setCargando(false));
  };

  useEffect(() => {
    buscar();
  }, [q, tipo]);

  const guardarNombre = async () => {
    setGuardandoNombre(true);
    try {
      await api.storeSetName(displayName.trim() || null);
      setMsg({ ok: true, t: '✓ Nombre de publicador guardado' });
      const r = await api.storeIdentity();
      setIdentity(r as IdentityData);
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    } finally {
      setGuardandoNombre(false);
    }
  };

  const instalar = async (item: StoreItem) => {
    const key = item.manifestId ?? item.id ?? '';
    setOcupado((o) => ({ ...o, [key]: true }));
    setMsg(null);
    try {
      await api.storeInstall(
        item.publisherId ?? '',
        item.manifestId ?? '',
        item.latestVersion ?? item.version ?? '',
      );
      setMsg({ ok: true, t: `✓ Plugin "${item.name ?? item.manifestId}" instalado` });
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    } finally {
      setOcupado((o) => ({ ...o, [key]: false }));
    }
  };

  const votar = async (item: StoreItem, kind: 'like' | 'dislike') => {
    const key = (item.manifestId ?? item.id ?? '') + kind;
    setOcupado((o) => ({ ...o, [key]: true }));
    setMsg(null);
    try {
      await api.storeVote(item.id ?? item.manifestId ?? '', kind);
      setMsg({ ok: true, t: `✓ Voto registrado` });
      buscar();
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    } finally {
      setOcupado((o) => ({ ...o, [key]: false }));
    }
  };

  const reportar = async (item: StoreItem) => {
    const motivo = prompt('Motivo del reporte (obligatorio):');
    if (!motivo?.trim()) return;
    const key = (item.manifestId ?? item.id ?? '') + 'report';
    setOcupado((o) => ({ ...o, [key]: true }));
    setMsg(null);
    try {
      await api.storeReport(item.id ?? item.manifestId ?? '', motivo.trim());
      setMsg({ ok: true, t: '✓ Reporte enviado' });
    } catch (e: unknown) {
      setMsg({ ok: false, t: '✗ ' + (e instanceof Error ? e.message : 'error') });
    } finally {
      setOcupado((o) => ({ ...o, [key]: false }));
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

      {/* Tarjeta de identidad */}
      <Card>
        <CardHeader
          title="Identidad de publicador"
          icon={<StoreIcon className="h-4 w-4" />}
          hint="Tu identidad en la tienda comunitaria. Opt-in: añade un nombre visible para que otros reconozcan tus plugins."
        />
        <CardBody className="space-y-3">
          <IdentityContent
            identityError={identityError}
            identity={identity}
            displayName={displayName}
            setDisplayName={setDisplayName}
            guardarNombre={guardarNombre}
            guardandoNombre={guardandoNombre}
          />
        </CardBody>
      </Card>

      {/* Catálogo */}
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

          {storeError && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              La tienda comunitaria no está disponible (error 502). Inténtalo más tarde.
            </div>
          )}

          {!storeError && !cargando && items.length === 0 && (
            <p className="text-mut text-[12px]">No se encontraron plugins con esos criterios.</p>
          )}

          {cargando && <p className="text-mut text-[12px]">Buscando…</p>}

          {!storeError && items.length > 0 && (
            <div className="space-y-2">
              {items.map((item) => {
                const key = item.manifestId ?? item.id ?? '';
                const likeBusy = ocupado[key + 'like'];
                const dislikeBusy = ocupado[key + 'dislike'];
                const reportBusy = ocupado[key + 'report'];
                const installBusy = ocupado[key];
                return (
                  <div
                    key={key}
                    className="rounded-md border border-edge/60 px-3 py-2.5 space-y-1.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span className="text-[13px] text-ink font-medium truncate">
                          {item.name ?? item.manifestId}
                        </span>
                        {item.type && (
                          <Badge tone={TIPO_TONE[item.type] ?? 'mut'}>{item.type}</Badge>
                        )}
                        {item.latestVersion && (
                          <span className="text-[11px] text-mut num shrink-0">
                            v{item.latestVersion}
                          </span>
                        )}
                        {item.publisherName && (
                          <span className="text-[11px] text-mut shrink-0">
                            por {item.publisherName}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                        {/* Contadores */}
                        {item.likes != null && (
                          <span className="text-[11px] text-mut num">{item.likes} 👍</span>
                        )}
                        {item.dislikes != null && (
                          <span className="text-[11px] text-mut num">{item.dislikes} 👎</span>
                        )}
                        {/* Votar */}
                        <button
                          onClick={() => votar(item, 'like')}
                          disabled={!!likeBusy}
                          title="Me gusta"
                          className="text-mut hover:text-accent disabled:opacity-40"
                        >
                          <ThumbsUp className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => votar(item, 'dislike')}
                          disabled={!!dislikeBusy}
                          title="No me gusta"
                          className="text-mut hover:text-danger disabled:opacity-40"
                        >
                          <ThumbsDown className="h-4 w-4" />
                        </button>
                        {/* Reportar */}
                        <button
                          onClick={() => reportar(item)}
                          disabled={!!reportBusy}
                          title="Reportar"
                          className="text-mut hover:text-warn disabled:opacity-40"
                        >
                          <Flag className="h-4 w-4" />
                        </button>
                        {/* Instalar */}
                        <button
                          onClick={() => instalar(item)}
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
          )}
        </CardBody>
      </Card>
    </div>
  );
}
