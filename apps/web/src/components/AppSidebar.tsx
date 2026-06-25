import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from './ui/sidebar';
import { Separator } from './ui/separator';
import {
  LayoutDashboard,
  Bell,
  TrendingUp,
  DraftingCompass,
  ChartArea,
  Brain,
  Globe,
  SlidersHorizontal,
  Settings,
  Plug,
  KeyRound,
  ScrollText,
  MessageSquare,
  NotebookPen,
  Puzzle,
  Store as StoreIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { auth } from '../lib/api';
import ThemeSwitcher from './ThemeSwitcher';
import Logo from './ui/Logo';
import Dashboard from './Dashboard';
import Notifications from './Notifications';
import Trades from './Trades';
import Strategies from './Strategies';
import Skills from './Skills';
import Universe from './Universe';
import Config from './Config';
import Parametros from './Parametros';
import Providers from './Providers';
import Credentials from './Credentials';
import Logs from './Logs';
import Chat from './Chat';
import Journal from './Journal';
import Plugins from './Plugins';
import Store from './Store';
import BacktestCompare from './BacktestCompare';

const PAGES: Record<string, () => JSX.Element> = {
  dashboard: () => <Dashboard />,
  notifications: () => <Notifications />,
  trades: () => <Trades />,
  strategies: () => <Strategies />,
  backtest: () => <BacktestCompare />,
  skills: () => <Skills />,
  universe: () => <Universe />,
  parametros: () => <Parametros />,
  config: () => (
    <Config only={['llm', 'loop', 'alerts', 'data_quality', 'providers', 'notifications']} />
  ),
  providers: () => <Providers />,
  credentials: () => <Credentials />,
  logs: () => <Logs />,
  chat: () => <Chat />,
  journal: () => <Journal />,
  plugins: () => <Plugins />,
  store: () => <Store />,
};

const GRUPOS: { label: string; items: { href: string; label: string; icon: LucideIcon }[] }[] = [
  {
    label: 'Operación',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/notifications', label: 'Notificaciones', icon: Bell },
      { href: '/trades', label: 'Operaciones', icon: TrendingUp },
      { href: '/strategies', label: 'Estrategias', icon: DraftingCompass },
      { href: '/backtest', label: 'Backtest', icon: ChartArea },
      { href: '/skills', label: 'Skills', icon: Brain },
    ],
  },
  {
    label: 'Configuración',
    items: [
      { href: '/universe', label: 'Universo', icon: Globe },
      { href: '/parametros', label: 'Parámetros', icon: SlidersHorizontal },
      { href: '/config', label: 'Configuración', icon: Settings },
      { href: '/providers', label: 'Proveedores', icon: Plug },
      { href: '/credentials', label: 'Credenciales', icon: KeyRound },
      { href: '/plugins', label: 'Plugins', icon: Puzzle },
      { href: '/store', label: 'Tienda', icon: StoreIcon },
    ],
  },
  {
    label: 'Observabilidad',
    items: [
      { href: '/logs', label: 'Logs', icon: ScrollText },
      { href: '/chat', label: 'Chat', icon: MessageSquare },
      { href: '/journal', label: 'Evidencia', icon: NotebookPen },
    ],
  },
];

export default function AppShell({
  title,
  path,
  page,
}: {
  title: string;
  path: string;
  page: string;
}) {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!auth.isAuthenticated()) {
      window.location.href = '/login';
    } else {
      setAuthed(true);
    }
  }, []);

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        Verificando sesión…
      </div>
    );
  }

  const Contenido = PAGES[page] || (() => <div className="text-mut">Página no encontrada</div>);
  const norm = (h: string) => h.replace(/\/$/, '') || '/';
  const activo = norm(path);

  function logout() {
    auth.clearToken();
    window.location.href = '/login';
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="px-2 py-2">
            <Logo showText size={36} subtitle="trading · paper" />
          </div>
        </SidebarHeader>
        <SidebarContent>
          {GRUPOS.map((g) => (
            <SidebarGroup key={g.label}>
              <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {g.items.map((n) => (
                    <SidebarMenuItem key={n.href}>
                      <SidebarMenuButton asChild isActive={activo === norm(n.href)}>
                        <a href={n.href}>
                          <n.icon className="h-4 w-4" />
                          <span>{n.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center justify-between px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              sistema operativo
            </div>
            <button
              onClick={logout}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              title="Cerrar sesión"
            >
              Salir
            </button>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/75 px-4 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <h1 className="text-base font-semibold tracking-tight">{title}</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground num hidden sm:block" id="clock" />
            <ThemeSwitcher />
          </div>
        </header>
        <div className="p-6 max-w-[1400px]">
          <Contenido />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
