import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export const fmt = {
  money: (n: number | null | undefined) =>
    n == null ? '—' : '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }),
  pct: (n: number | null | undefined, d = 2) => {
    if (n == null) return '—';
    const sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(d) + '%';
  },
  num: (n: number | null | undefined, d = 2) => (n == null ? '—' : n.toFixed(d)),
};
