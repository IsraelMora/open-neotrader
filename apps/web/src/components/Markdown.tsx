import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ComponentProps } from 'react';

type CodeProps = ComponentProps<'code'> & { className?: string };

// Renderizador de Markdown con estilos de tema (no usa el plugin typography:
// definimos cada elemento para respetar los colores/fuentes del panel).
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed space-y-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="text-base font-semibold text-ink mt-3 mb-1" {...p} />,
          h2: (p) => <h2 className="text-sm font-semibold text-ink mt-3 mb-1" {...p} />,
          h3: (p) => <h3 className="text-sm font-semibold text-mut mt-2 mb-1" {...p} />,
          p: (p) => <p className="text-ink/90" {...p} />,
          ul: (p) => <ul className="list-disc pl-5 space-y-0.5 text-ink/90" {...p} />,
          ol: (p) => <ol className="list-decimal pl-5 space-y-0.5 text-ink/90" {...p} />,
          li: (p) => <li className="marker:text-mut" {...p} />,
          a: (p) => (
            <a
              className="text-accent underline underline-offset-2 hover:text-accent/80"
              target="_blank"
              rel="noreferrer"
              {...p}
            />
          ),
          strong: (p) => <strong className="font-semibold text-ink" {...p} />,
          em: (p) => <em className="italic" {...p} />,
          blockquote: (p) => (
            <blockquote className="border-l-2 border-accent/40 pl-3 text-mut italic" {...p} />
          ),
          hr: () => <hr className="border-edge my-3" />,
          code: ({ className, children: codeChildren, ...props }: CodeProps) => {
            const inline = !className;
            return inline ? (
              <code
                className="rounded bg-edge/60 px-1.5 py-0.5 text-[12px] num text-accent"
                {...props}
              >
                {codeChildren}
              </code>
            ) : (
              <code
                className={`block overflow-x-auto rounded-md bg-bg border border-edge p-3 text-[12px] num text-ink/90 ${className || ''}`}
                {...props}
              >
                {codeChildren}
              </code>
            );
          },
          pre: (p) => <pre className="my-2" {...p} />,
          table: (p) => (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] border-collapse" {...p} />
            </div>
          ),
          thead: (p) => <thead className="border-b border-edge" {...p} />,
          th: (p) => <th className="text-left font-semibold text-mut px-2 py-1" {...p} />,
          td: (p) => <td className="border-b border-edge/40 px-2 py-1 num" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
