import { useEffect, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { api, type JsonObject } from '../lib/api';
export default function Journal() {
  const [data, setData] = useState<JsonObject | null>(null);
  useEffect(() => {
    api
      .journal()
      .then(setData)
      .catch(() => {});
  }, []);
  return (
    <Card>
      <CardHeader
        title="Evidencia y disciplina"
        hint="Candado de parámetros, n_trials, DSR — la red anti-overfitting."
      />
      <CardBody>
        {!data ? (
          <div className="text-mut text-sm animate-pulse">Cargando…</div>
        ) : (
          <pre className="num text-[12px] whitespace-pre-wrap text-ink max-h-[72vh] overflow-y-auto">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </CardBody>
    </Card>
  );
}
