import type { ReactNode } from 'react';
import { Card as ShadCard, CardContent, CardTitle, CardDescription } from './shad-card';
import { cn } from '@/lib/utils';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <ShadCard className={cn('gap-0 py-0 backdrop-blur-sm', className)}>{children}</ShadCard>;
}

export function CardHeader({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        {icon && <span className="text-primary/80">{icon}</span>}
        <CardTitle className="text-sm tracking-tight">{title}</CardTitle>
      </div>
      {hint && (
        <CardDescription className="text-[11px] max-w-[55%] text-right leading-relaxed">
          {hint}
        </CardDescription>
      )}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <CardContent className={cn('px-5 py-4', className)}>{children}</CardContent>;
}
