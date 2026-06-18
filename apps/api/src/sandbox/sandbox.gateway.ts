import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';

export interface SandboxRequest {
  cmd: string; // abierto: cualquier comando que runner.py soporte
  [key: string]: unknown;
}

export interface SandboxResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

@Injectable()
export class SandboxGateway {
  private readonly log = new Logger(SandboxGateway.name);
  private readonly timeout: number;
  private readonly runnerPath: string;
  private readonly pluginsDir: string;
  private readonly sdkPath: string;

  private readonly cpuSeconds: number;
  private readonly memMb: number;
  /** Ruta absoluta al intérprete Python. Configurable por portabilidad (Docker/venv/distro). */
  private readonly python3Bin: string;

  constructor(cfg: ConfigService) {
    this.python3Bin = cfg.get<string>('PYTHON3_BIN', '/usr/bin/python3');
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
  }

  async call(req: SandboxRequest): Promise<SandboxResponse> {
    return new Promise((resolve) => {
      const existingPythonPath = process.env['PYTHONPATH'] ?? '';
      const proc = spawn(this.python3Bin, [this.runnerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NEUROTRADER_PLUGINS_DIR: this.pluginsDir,
          PYTHONPATH: existingPythonPath ? `${this.sdkPath}:${existingPythonPath}` : this.sdkPath,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUNBUFFERED: '1',
          SANDBOX_CPU_SECONDS: String(this.cpuSeconds),
          SANDBOX_MEM_MB: String(this.memMb),
        },
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
    return this.call({ cmd: 'call_plugin', plugin_id: pluginId, function: fn, args, context });
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
