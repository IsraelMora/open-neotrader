import { useCallback, useEffect, useRef, useState } from 'react';

/** Estado estándar de un recurso cargado de forma asíncrona. */
export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Vuelve a ejecutar el fetcher (para botones "reintentar" o refrescos manuales). */
  reload: () => void;
  /** Permite mutar el dato localmente (p.ej. update optimista) sin refetch. */
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

/**
 * Hook genérico de carga de datos: elimina el boilerplate de
 * `useState(data)` + `useState(loading)` + `useState(error)` + `useEffect(fetch)`
 * que cada vista repetía. Devuelve `{ data, loading, error, reload }`.
 *
 * `pollMs` opcional: refresca en intervalo (reemplaza los `setInterval` manuales).
 * El fetcher se lee siempre por ref, así que puede cerrar sobre props/estado actuales.
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  opts: { pollMs?: number } = {},
): Resource<T> {
  const { pollMs } = opts;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((d) => setData(d))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'No se pudo cargar'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    if (!pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);

  return { data, loading, error, reload, setData };
}
