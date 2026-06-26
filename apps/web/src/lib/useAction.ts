import { useCallback, useState } from 'react';
import { useToast } from '../components/ui/Toast';

/**
 * Hook genérico para ejecutar acciones (POST/PATCH/DELETE) con manejo estándar de
 * estado `busy` + feedback por toast. Elimina el boilerplate de `try/catch/setMsg/setBusy`
 * que cada vista repetía en cada handler.
 *
 *   const { busy, run } = useAction();
 *   run(() => api.pluginAction(id, 'activate'), { success: '✓ activado', onDone: reload });
 */
export function useAction() {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (
      fn: () => Promise<unknown>,
      opts: { success?: string; onDone?: () => void } = {},
    ): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        if (opts.success) notify(opts.success, 'success');
        opts.onDone?.();
        return true;
      } catch (e: unknown) {
        notify(e instanceof Error ? e.message : 'Ocurrió un error', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );

  return { busy, run };
}
