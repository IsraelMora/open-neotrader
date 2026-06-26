import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, TriangleAlert, Info } from 'lucide-react';

/** Tipos de toast estándar, compartidos por el panel completo. */
export type ToastKind = 'success' | 'error' | 'warn' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  /** Muestra un toast del tipo indicado (default: success). */
  notify: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ notify: () => {} });

/** Acceso al manager de toasts global — feedback de acciones unificado para el panel. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TOAST_STYLE: Record<ToastKind, string> = {
  success: 'border-accent/40 bg-accent/10 text-accent',
  error: 'border-danger/40 bg-danger/10 text-danger',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  info: 'border-info/40 bg-info/10 text-info',
};

const TOAST_ICON: Record<ToastKind, React.ComponentType<{ className?: string }>> = {
  success: CircleCheck,
  error: CircleX,
  warn: TriangleAlert,
  info: Info,
};

function ToastView({ kind, text }: { kind: ToastKind; text: string }) {
  const Icon = TOAST_ICON[kind];
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-md border px-4 py-2.5 text-sm shadow-lg ${TOAST_STYLE[kind]}`}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}

let nextToastId = 0;

/**
 * Provider global de toasts. Se monta una sola vez en AppShell para que cada vista
 * comparta el mismo manager de feedback en vez de mapear su propio `msg`/banner.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (text: string, kind: ToastKind = 'success') => {
      const id = nextToastId++;
      setToasts((prev) => [...prev, { id, kind, text }]);
      setTimeout(() => remove(id), 4000);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastView key={t.id} kind={t.kind} text={t.text} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
