import { useEffect, useState } from 'react';

const VARS = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--primary',
  '--info',
];

export interface ChartTheme {
  serie: string[];
  grid: string;
  tick: string;
  tip: string;
  tipBorde: string;
  tipTexto: string;
}

function leerTema(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim() || '#888';
  return {
    serie: VARS.map(v),
    grid: v('--border'),
    tick: v('--muted-foreground'),
    tip: v('--popover'),
    tipBorde: v('--border'),
    tipTexto: v('--popover-foreground'),
  };
}

export function useChartTheme(): ChartTheme | null {
  const [tema, setTema] = useState<ChartTheme | null>(() =>
    typeof document !== 'undefined' ? leerTema() : null,
  );

  useEffect(() => {
    setTema(leerTema());
    const obs = new MutationObserver(() => setTema(leerTema()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  return tema;
}

export { VARS };
