// Distancia de Levenshtein (edición) entre dos strings.
function levenshtein(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// ¿`texto` casa con `query` de forma difusa? Casa si:
//  - contiene la query como substring (rápido, prioritario), o
//  - alguna palabra del texto está a distancia Levenshtein ≤ tolerancia
//    (tolerancia ∝ longitud de la query → tolera erratas).
export function fuzzyMatch(texto: string, query: string): boolean {
  query = query.trim().toLowerCase();
  if (!query) return true;
  const t = texto.toLowerCase();
  if (t.includes(query)) return true;
  let tol = 3;
  if (query.length <= 4) tol = 1;
  else if (query.length <= 7) tol = 2;
  const tooFarWord = (w: string) => w && levenshtein(w, query) <= tol;
  return t.split(/[\s,._/:-]+/).some(tooFarWord);
}

// Filtra una lista de objetos por los campos dados, con match difuso.
export function fuzzyFilter<T>(items: T[], query: string, campos: (keyof T)[]): T[] {
  if (!query.trim()) return items;
  return items.filter((it) => campos.some((c) => fuzzyMatch(String(it[c] ?? ''), query)));
}
