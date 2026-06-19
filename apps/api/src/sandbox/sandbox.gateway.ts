import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';
import type { PluginManifest } from '../plugins/manifest';
import { readManifest } from '../plugins/manifest';

export interface SandboxRequest {
  cmd: string; // abierto: cualquier comando que runner.py soporte
  [key: string]: unknown;
}

export interface SandboxResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Options consumed by buildSandboxEnv. */
export interface SandboxEnvOpts {
  pluginsDir: string;
  sdkPath: string;
  cpuSeconds: number;
  memMb: number;
  /** When true, host PYTHONPATH is dropped and import/open guards are active. Default: true. */
  sandboxStrict: boolean;
}

/**
 * Builds the subprocess environment for the sandbox runner.
 *
 * Allowlist-only: only the keys listed here are ever passed to the subprocess.
 * No `...process.env` spread — closed-by-default boundary so future secrets
 * added to .env cannot leak.
 *
 * In strict mode PYTHONPATH is sdk-only (host path dropped).
 * In non-strict mode host PYTHONPATH is appended (dev convenience, logged as warn).
 */
export function buildSandboxEnv(
  processEnv: NodeJS.ProcessEnv,
  opts: SandboxEnvOpts,
): NodeJS.ProcessEnv {
  const hostPythonPath = processEnv['PYTHONPATH'] ?? '';
  const pythonPath =
    opts.sandboxStrict || !hostPythonPath ? opts.sdkPath : `${opts.sdkPath}:${hostPythonPath}`;

  return {
    PATH: processEnv['PATH'] ?? '',
    NEUROTRADER_PLUGINS_DIR: opts.pluginsDir,
    PYTHONPATH: pythonPath,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    SANDBOX_CPU_SECONDS: String(opts.cpuSeconds),
    SANDBOX_MEM_MB: String(opts.memMb),
    SANDBOX_STRICT: String(opts.sandboxStrict),
  };
}

/**
 * Resolves plugin credentials from the kernel secret store (processEnv).
 *
 * Only credential keys DECLARED in the plugin's manifest [credentials] section
 * are included in the result. Undeclared secrets are never exposed.
 * Missing declared keys resolve to an empty string rather than undefined.
 *
 * The returned object is meant to be placed in `context.credentials` of the
 * SandboxRequest — never injected into the subprocess env.
 */
export function resolveCredentials(
  manifest: PluginManifest,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const declared = manifest.credentials;
  if (!declared || Object.keys(declared).length === 0) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const key of Object.keys(declared)) {
    result[key] = processEnv[key] ?? '';
  }
  return result;
}

/** Puerta de entrada al sandbox Python (runner.py): ejecuta plugins de forma aislada enviando JSON por stdin/stdout. */
@Injectable()
export class SandboxGateway {
  private readonly log = new Logger(SandboxGateway.name);
  private readonly timeout: number;
  private readonly runnerPath: string;
  private readonly pluginsDir: string;
  private readonly sdkPath: string;

  private readonly cpuSeconds: number;
  private readonly memMb: number;
  private readonly sandboxStrict: boolean;
  /** Intérprete Python. Default resuelto por PATH (respeta venvs/pyenv); override con PYTHON3_BIN. */
  private readonly python3Bin: string;

  constructor(cfg: ConfigService) {
    this.python3Bin = cfg.get<string>('PYTHON3_BIN', 'python3');
    this.timeout = cfg.get<number>('SANDBOX_TIMEOUT_MS', 30_000);
    this.runnerPath = cfg.get<string>(
      'SANDBOX_RUNNER_PATH',
      path.resolve(__dirname, '../../../../sandbox/runner.py'),
    );
    this.pluginsDir = cfg.get<string>(
      'PLUGINS_DIR',
      path.resolve(__dirname, '../../../../../plugins'),
    );
    this.sdkPath = cfg.get<string>(
      'PLUGIN_SDK_PATH',
      path.resolve(__dirname, '../../../../../packages/plugin-sdk'),
    );
    this.cpuSeconds = cfg.get<number>('SANDBOX_CPU_SECONDS', 60);
    this.memMb = cfg.get<number>('SANDBOX_MEM_MB', 512);
    // Default true (prod-safe). Set SANDBOX_STRICT=false only for bare-metal dev.
    this.sandboxStrict = cfg.get<string>('SANDBOX_STRICT', 'true') !== 'false';
  }

  /** Envía un comando al runner.py y retorna la respuesta parseada. Mata el proceso si supera el timeout. */
  async call(req: SandboxRequest): Promise<SandboxResponse> {
    return new Promise((resolve) => {
      if (!this.sandboxStrict) {
        this.log.warn(
          'SANDBOX_STRICT=false: host PYTHONPATH allowed, import/open guards will be inactive',
        );
      }
      const sandboxEnv = buildSandboxEnv(process.env, {
        pluginsDir: this.pluginsDir,
        sdkPath: this.sdkPath,
        cpuSeconds: this.cpuSeconds,
        memMb: this.memMb,
        sandboxStrict: this.sandboxStrict,
      });
      const proc = spawn(this.python3Bin, [this.runnerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sandboxEnv,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({ ok: false, error: `timeout after ${this.timeout}ms` });
      }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          this.log.warn(`Sandbox exit ${code} stderr: ${stderr.slice(0, 400)}`);
          resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as SandboxResponse);
        } catch {
          resolve({ ok: false, error: `JSON inválido del sandbox: ${stdout.slice(0, 100)}` });
        }
      });

      proc.stdin?.write(JSON.stringify(req));
      proc.stdin?.end();
    });
  }

  /** Llama a una función de un plugin provider/discipline */
  callPlugin(
    pluginId: string,
    fn: string,
    args: Record<string, unknown> = {},
    context: Record<string, unknown> = {},
  ): Promise<SandboxResponse> {
    const pluginDir = path.join(this.pluginsDir, pluginId);
    const manifest = readManifest(pluginDir);
    const credentials = manifest ? resolveCredentials(manifest, process.env) : {};
    const enrichedContext = { ...context, credentials };
    return this.call({
      cmd: 'call_plugin',
      plugin_id: pluginId,
      function: fn,
      args,
      context: enrichedContext,
    });
  }

  /** Ejecuta el hook on_cycle de todos los plugins activos */
  runCycle(activeIds: string[], context: Record<string, unknown> = {}): Promise<SandboxResponse> {
    return this.call({ cmd: 'run_cycle', active_ids: activeIds, context });
  }

  /** Ejecuta el hook on_activate de un plugin */
  runActivateHook(pluginId: string, installedPath: string): Promise<SandboxResponse> {
    return this.call({
      cmd: 'run_hook',
      plugin_id: pluginId,
      hook: 'on_activate',
      installed_path: installedPath,
    });
  }

  /** Ejecuta el hook on_deactivate de un plugin */
  runDeactivateHook(pluginId: string, installedPath: string): Promise<SandboxResponse> {
    return this.call({
      cmd: 'run_hook',
      plugin_id: pluginId,
      hook: 'on_deactivate',
      installed_path: installedPath,
    });
  }

  /** Emite un evento generado por un plugin Python al bus de la plataforma */
  emitPluginSignal(
    pluginId: string,
    signalType: string,
    payload: Record<string, unknown>,
  ): Promise<SandboxResponse> {
    return this.call({ cmd: 'emit_signal', plugin_id: pluginId, signal_type: signalType, payload });
  }

  /** Ejecuta el hook on_cycle de un plugin individual con su contexto */
  runPluginCycleHook(
    pluginId: string,
    context: Record<string, unknown> = {},
  ): Promise<SandboxResponse> {
    return this.call({ cmd: 'run_hook', plugin_id: pluginId, hook: 'on_cycle', context });
  }

  /** Diagnóstico: lista plugins que runner.py reconoce */
  listPlugins(activeIds: string[]): Promise<SandboxResponse> {
    return this.call({ cmd: 'list_plugins', active_ids: activeIds });
  }
}
