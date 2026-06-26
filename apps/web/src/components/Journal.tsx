import { useEffect, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { api, type JsonObject } from '../lib/api';
export default function Journal() {
  const [data, setData] = useState<JsonObject | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .journal()
      .then(setData)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'No se pudo cargar'));
  }, []);
  let body;
  if (err) {
    body = <div className="text-danger text-sm">{err}</div>;
  } else if (!data) {
    body = <div className="text-mut text-sm animate-pulse">Cargando…</div>;
  } else {
    body = (
      <pre className="num text-[12px] whitespace-pre-wrap text-ink max-h-[72vh] overflow-y-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Evidencia y disciplina"
        hint="Candado de parámetros, n_trials, DSR — la red anti-overfitting."
      />
      <CardBody>{body}</CardBody>
    </Card>
  );
}
