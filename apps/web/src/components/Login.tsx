import { useState } from 'react';
import { api, auth } from '../lib/api';
import Logo from './ui/Logo';

type Mode = 'login' | 'register' | 'totp';

function submitLabel(mode: Mode): string {
  if (mode === 'register') return 'Crear cuenta';
  if (mode === 'totp') return 'Verificar';
  return 'Entrar';
}

export default function Login() {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingToken, setPendingToken] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'totp') {
        auth.setToken(pendingToken);
        const res = await api.totpVerify(code);
        auth.setToken(res.access_token);
        window.location.href = '/';
        return;
      }
      if (mode === 'register') {
        await api.register(username, password);
        setMode('login');
        setError('');
        return;
      }
      // login
      const res = await api.login(username, password);
      if (res.totp_required) {
        setPendingToken(res.access_token);
        setMode('totp');
      } else {
        auth.setToken(res.access_token);
        window.location.href = '/';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="text-center space-y-2">
          <div className="mx-auto flex justify-center pb-2">
            <Logo size={56} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">OpenNeoTrader</h1>
          <p className="text-sm text-muted-foreground">
            {mode === 'login' && 'Accede al panel de control'}
            {mode === 'register' && 'Crea el operador inicial'}
            {mode === 'totp' && 'Introduce el código TOTP'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode !== 'totp' && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Usuario</label>
                <input
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Contraseña</label>
                <input
                  type="password"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  required
                />
              </div>
            </>
          )}

          {mode === 'totp' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Código 6 dígitos</label>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-center tracking-widest text-lg font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                maxLength={6}
                autoFocus
                required
              />
            </div>
          )}

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Cargando…' : submitLabel(mode)}
          </button>
        </form>

        {mode !== 'totp' && (
          <p className="text-center text-sm text-muted-foreground">
            {mode === 'login' ? (
              <>
                ¿Primera vez?{' '}
                <button
                  onClick={() => {
                    setMode('register');
                    setError('');
                  }}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  Crear operador
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
                className="text-primary underline-offset-4 hover:underline"
              >
                ← Volver al login
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
