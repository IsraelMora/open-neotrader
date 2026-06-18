import type { ReactNode } from 'react';
import { Badge as ShadBadge } from './shad-badge';
import { cn } from '@/lib/utils';

const toneClasses: Record<string, string> = {
  ok: 'bg-primary/10 text-primary border-primary/30 rounded-md',
  warn: 'bg-warn/10 text-warn border-warn/30 rounded-md',
  danger: 'bg-destructive/10 text-destructive border-destructive/30 rounded-md',
  info: 'bg-info/10 text-info border-info/30 rounded-md',
  mut: 'bg-border/60 text-muted-foreground border-border rounded-md',
};

export function Badge({
  tone = 'mut',
  children,
  className,
}: {
  tone?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ShadBadge
      variant="outline"
      className={cn('text-[11px] font-medium', toneClasses[tone] ?? toneClasses.mut, className)}
    >
      {children}
    </ShadBadge>
  );
}
