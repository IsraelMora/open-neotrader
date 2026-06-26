import type { ReactNode } from 'react';

/**
 * Render estándar de un recurso asíncrono: loading → error (con reintentar) → vacío → contenido.
 * Reemplaza el `if (!data) return <Cargando/>` y los banners de error que cada vista repetía.
 *
 *   const { data, loading, error, reload } = useResource(() => api.trades());
 *   <AsyncBoundary loading={loading} error={error} onRetry={reload} isEmpty={!data?.length}>
 *     ...contenido con data...
 *   </AsyncBoundary>
 */
export function AsyncBoundary({
  loading,
  error,
  onRetry,
  isEmpty,
  loadingText = 'Cargando…',
  emptyText = 'Sin datos.',
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  isEmpty?: boolean;
  loadingText?: string;
  emptyText?: string;
  children: ReactNode;
}) {
  if (loading) {
    return <div className="text-mut text-sm animate-pulse">{loadingText}</div>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
        <div className="font-medium">No se pudo cargar</div>
        <p className="mt-1 text-[12px] opacity-80">{error}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 rounded border border-danger/40 px-3 py-1 text-[12px] hover:bg-danger/20"
          >
            Reintentar
          </button>
        )}
      </div>
    );
  }
  if (isEmpty) {
    return <p className="text-mut text-[12px] py-6 text-center">{emptyText}</p>;
  }
  return <>{children}</>;
}
