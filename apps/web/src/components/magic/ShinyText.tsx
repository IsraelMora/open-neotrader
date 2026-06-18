import type { ReactNode } from 'react';
export function ShinyText({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-block bg-clip-text text-transparent ${className}`}
      style={{
        backgroundImage:
          'linear-gradient(110deg, hsl(var(--muted-foreground)) 40%, hsl(var(--foreground)) 50%, hsl(var(--muted-foreground)) 60%)',
        backgroundSize: '200% 100%',
        animation: 'shine 3s linear infinite',
      }}
    >
      {children}
      <style>{`@keyframes shine{to{background-position:-200% 0}}`}</style>
    </span>
  );
}
