import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

// Toggle claro/oscuro. El tema (tweakcn) vive en globals.css como :root/.dark.
export default function ThemeSwitcher() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('panel-mode', next ? 'dark' : 'light');
    } catch {
      /* storage blocked */
    }
    setDark(next);
  };
  return (
    <button
      onClick={toggle}
      aria-label="Cambiar tema"
      className="flex items-center gap-2 rounded-md border border-edge bg-panel/60 px-2.5 py-1.5 text-[12px] text-mut hover:text-ink transition-colors"
    >
      {dark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
      {dark ? 'Oscuro' : 'Claro'}
    </button>
  );
}
