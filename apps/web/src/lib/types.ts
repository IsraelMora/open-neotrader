export interface Strategy {
  id: string;
  name: string;
  description: string | null;
  config: Record<string, string>;
  active: boolean;
  mode: 'test' | 'live';
}

export interface Stats {
  n_points: number;
  nav: number | null;
  return_pct: number | null;
  sharpe: number | null;
  max_drawdown_pct: number | null;
}
