import { Injectable, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';
import { PluginsService } from '../plugins/plugins.service';
import { LlmService } from '../llm/llm.service';
import { KvService } from '../common/kv.service';
import { kvBool } from '../common/kv.util';

export interface OnboardingStep {
  id: string;
  label: string;
  description: string;
  required: boolean;
  completed: boolean;
}

export interface OnboardingStatus {
  completed: boolean;
  current_step: string | null;
  steps: OnboardingStep[];
}

const ONBOARDING_DONE_KEY = 'onboarding:completed';

/** Gestiona el wizard de primera instalación: pasos completados, creación del admin y marcado de onboarding. */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly plugins: PluginsService,
    private readonly llm: LlmService,
    private readonly kv: KvService,
    private readonly cfg: ConfigService,
  ) {}

  /** Devuelve el estado del onboarding: si está completo, el paso pendiente actual y todos los pasos. */
  async getStatus(): Promise<OnboardingStatus> {
    const done = await this.kv.get(ONBOARDING_DONE_KEY);
    if (kvBool(done, false)) {
      return { completed: true, current_step: null, steps: await this.buildSteps() };
    }

    const steps = await this.buildSteps();
    const pending = steps.filter((s) => s.required && !s.completed);
    const current_step = pending[0]?.id ?? null;

    // Auto-completar si todos los pasos requeridos están hechos
    if (!current_step) {
      await this.kv.set(ONBOARDING_DONE_KEY, 'true');
      return { completed: true, current_step: null, steps };
    }

    return { completed: false, current_step, steps };
  }

  /** ¿Es la primera instalación? (ningún usuario en la BD) */
  async isFirstInstall(): Promise<boolean> {
    return (await this.users.count()) === 0;
  }

  /**
   * Crear el primer usuario admin.
   * Solo disponible cuando no hay ningún usuario (primera instalación).
   */
  async createAdmin(
    username: string,
    password: string,
  ): Promise<{ access_token: string; totp_required: boolean }> {
    const first = await this.isFirstInstall();
    if (!first) {
      throw new ForbiddenException('Ya existe un usuario admin. Usa POST /auth/register');
    }

    const user = await this.users.create(username, password);
    return this.auth.issueToken(user);
  }

  /** Marcar onboarding como completado manualmente */
  async markComplete(): Promise<void> {
    await this.kv.set(ONBOARDING_DONE_KEY, 'true');
  }

  /** Resetear onboarding (solo en dev) */
  async reset(): Promise<void> {
    await this.kv.delete(ONBOARDING_DONE_KEY);
  }

  // ── Privado ──────────────────────────────────────────────────────────────

  private async buildSteps(): Promise<OnboardingStep[]> {
    const userCount = await this.users.count();
    const activePlugins = await this.plugins.findAll().then((ps) => ps.filter((p) => p.active));
    const llmCfg = this.llm.getConfig();
    const hasLlmKey = !!(
      this.cfg.get('ANTHROPIC_API_KEY') ||
      this.cfg.get('OPENAI_API_KEY') ||
      this.cfg.get('GEMINI_API_KEY') ||
      llmCfg.active_custom_provider
    );

    return [
      {
        id: 'create_admin',
        label: 'Crear usuario admin',
        description: 'Configura las credenciales del administrador principal',
        required: true,
        completed: userCount > 0,
      },
      {
        id: 'configure_llm',
        label: 'Configurar LLM',
        description:
          'Añade tu API key de Anthropic, OpenAI, Gemini, o configura un proveedor custom',
        required: true,
        completed: hasLlmKey,
      },
      {
        id: 'install_plugin',
        label: 'Instalar primer plugin',
        description: 'Instala y activa al menos un plugin (skill, provider, universe o discipline)',
        required: true,
        completed: activePlugins.length > 0,
      },
      {
        id: 'setup_2fa',
        label: 'Activar 2FA (recomendado)',
        description: 'Protege tu cuenta con autenticación de doble factor via TOTP',
        required: false,
        completed: false, // Se verifica en el frontend consultando el perfil del usuario
      },
    ];
  }
}
