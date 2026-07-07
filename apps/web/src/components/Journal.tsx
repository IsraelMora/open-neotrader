import { Card, CardHeader, CardBody } from './ui/Card';
import { AsyncBoundary } from './ui/AsyncBoundary';
import { useResource } from '../lib/useResource';
import { api, type JsonObject } from '../lib/api';

export default function Journal() {
  const { data, loading, error, reload } = useResource<JsonObject>(() => api.journal());
  return (
    <Card>
      <CardHeader
        title="Evidencia y disciplina"
        hint="Candado de parámetros y umbrales de gates — disciplina anti-overfitting."
      />
      <CardBody>
        <AsyncBoundary
          loading={loading}
          error={error}
          onRetry={reload}
          isEmpty={!data}
          loadingText="Cargando…"
        >
          {data && <JournalContent data={data} />}
        </AsyncBoundary>
      </CardBody>
    </Card>
  );
}

function JournalContent({ data }: { data: JsonObject }) {
  return (
    <pre className="num text-[12px] whitespace-pre-wrap text-ink max-h-[72vh] overflow-y-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
