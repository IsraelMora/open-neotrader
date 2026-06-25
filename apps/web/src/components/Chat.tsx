import { useEffect, useRef, useState } from 'react';
import { Card, CardHeader, CardBody } from './ui/Card';
import { Markdown } from './Markdown';
import { Bot, User, Send, MessageSquare } from 'lucide-react';
import { api } from '../lib/api';

type Msg = { role: 'user' | 'ai' | 'err'; text: string };

const SUGERENCIAS = [
  '¿Cómo van las carteras?',
  '¿Qué vetó el LLM y acertó?',
  '¿Por qué se rechazó añadir bonos?',
  '¿Qué parámetros están bajo candado?',
];

function MsgBody({ msg: m, busy, ultimo }: { msg: Msg; busy: boolean; ultimo: boolean }) {
  const esUser = m.role === 'user';
  if (esUser || m.role === 'err') {
    return <span className="text-sm whitespace-pre-wrap">{m.text}</span>;
  }
  if (m.text) {
    return <Markdown>{m.text}</Markdown>;
  }
  if (busy && ultimo) {
    return (
      <span className="inline-flex gap-1 py-1" aria-label="escribiendo">
        <span className="h-1.5 w-1.5 rounded-full bg-mut animate-bounce [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-mut animate-bounce [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-mut animate-bounce" />
      </span>
    );
  }
  return null;
}

function avatarClass(role: Msg['role']): string {
  if (role === 'user') return 'bg-info/15 text-info';
  if (role === 'err') return 'bg-danger/15 text-danger';
  return 'bg-accent/15 text-accent';
}

function bubbleClass(role: Msg['role']): string {
  if (role === 'user') return 'bg-info/12 text-ink rounded-tr-sm';
  if (role === 'err') return 'bg-danger/10 text-danger rounded-tl-sm';
  return 'bg-edge/50 text-ink rounded-tl-sm';
}

export default function Chat() {
  const [q, setQ] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);

  const send = async (texto?: string) => {
    const question = (texto ?? q).trim();
    if (!question || busy) return;
    setQ('');
    if (taRef.current) taRef.current.style.height = 'auto';
    const history = msgs
      .filter((m) => m.role !== 'err')
      .slice(-6)
      .map((m) => (m.role === 'user' ? { question: m.text } : { answer: m.text }));
    setMsgs((m) => [...m, { role: 'user', text: question }, { role: 'ai', text: '' }]);
    setBusy(true);

    try {
      const r = await api.chat(question, history);
      const answer = (r as { response?: string }).response ?? '';
      setMsgs((m) => {
        const c = [...m];
        c[c.length - 1] = answer
          ? { role: 'ai', text: answer }
          : { role: 'err', text: 'respuesta vacía' };
        return c;
      });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : 'Error desconocido';
      setMsgs((m) => {
        const c = [...m];
        c[c.length - 1] = { role: 'err', text: errMsg };
        return c;
      });
    }
    setBusy(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  };

  return (
    <Card>
      <CardHeader
        title="Chat con el agente"
        icon={<MessageSquare className="h-4 w-4" />}
        hint="Pregunta sobre carteras, decisiones, vetos, evidencia y configuración. Solo lectura."
      />
      <CardBody>
        <div
          ref={scroller}
          className="space-y-4 mb-4 min-h-[260px] max-h-[58vh] overflow-y-auto pr-1"
        >
          {msgs.length === 0 && (
            <div className="py-8 text-center space-y-4">
              <div className="grid place-items-center">
                <div className="grid h-12 w-12 place-items-center rounded-full bg-accent/15 text-accent">
                  <Bot className="h-6 w-6" />
                </div>
              </div>
              <p className="text-mut text-sm">
                Pregúntame sobre el estado del agente. Algunas ideas:
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGERENCIAS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full border border-edge bg-panel/60 px-3 py-1.5 text-[12px] text-mut hover:text-ink hover:border-accent/50 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {msgs.map((m, i) => {
            const esUser = m.role === 'user';
            const ultimo = i === msgs.length - 1;
            return (
              <div key={i} className={`flex gap-2.5 ${esUser ? 'flex-row-reverse' : ''}`}>
                <div
                  className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${avatarClass(m.role)}`}
                >
                  {esUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </div>
                <div
                  className={`min-w-0 max-w-[82%] rounded-2xl px-3.5 py-2.5 ${bubbleClass(m.role)}`}
                >
                  <MsgBody msg={m} busy={busy} ultimo={ultimo} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-end gap-2 rounded-xl border border-edge bg-bg px-3 py-2 focus-within:border-accent/50 transition-colors">
          <textarea
            ref={taRef}
            value={q}
            rows={1}
            onChange={(e) => {
              setQ(e.target.value);
              autosize();
            }}
            onKeyDown={onKey}
            placeholder="Escribe tu pregunta…  (Enter envía · Shift+Enter salto de línea)"
            className="flex-1 resize-none bg-transparent py-1 text-sm text-ink outline-none placeholder:text-mut/70"
          />
          <button
            onClick={() => send()}
            disabled={busy || !q.trim()}
            aria-label="Enviar"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/90 text-bg hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </CardBody>
    </Card>
  );
}
