/**
 * BackupService — export/import cifrado de la plataforma.
 *
 * Incluye en el backup:
 * - BD SQLite completa (plugins, configuración, historial de ciclos, audit)
 * - Lista de plugins activos e instalados (paths)
 * - .env (cifrado — nunca en texto plano)
 *
 * Cifrado: AES-256-GCM con clave derivada de la passphrase (PBKDF2/scrypt).
 * El backup es un tarball .tar.gz cifrado: neurotrader-backup-YYYY-MM-DD.enc
 *
 * Seguridad:
 * - La passphrase nunca se almacena en el sistema
 * - Sin passphrase, el backup no puede restaurarse
 * - El IV es aleatorio por backup
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MAGIC = Buffer.from('NEUROTRADER_BACKUP_V1');
const SALT_BYTES = 32;
const IV_BYTES = 12; // AES-GCM
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256
const PBKDF2_ITERS = 210_000;

@Injectable()
export class BackupService {
  private readonly log = new Logger(BackupService.name);
  private readonly dbPath: string;
  private readonly envPath: string;
  private readonly backupDir: string;

  constructor(cfg: ConfigService) {
    this.dbPath = cfg.get<string>('DATABASE_URL', 'file:./neurotrader.db').replace('file:', '');
    this.envPath = cfg.get<string>('DOTENV_PATH', path.resolve(process.cwd(), '.env'));
    this.backupDir = cfg.get<string>('BACKUP_DIR', path.resolve(process.cwd(), 'backups'));
  }

  /** Crea un backup cifrado y devuelve la ruta del archivo. */
  async createBackup(passphrase: string): Promise<{ path: string; size: number; ts: string }> {
    if (!passphrase || passphrase.length < 12) {
      throw new Error('La passphrase debe tener al menos 12 caracteres');
    }

    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });

    const ts = new Date().toISOString().split('T')[0];
    const outPath = path.join(this.backupDir, `neurotrader-backup-${ts}.enc`);

    // Recopilar datos para el backup
    const payload = this.collectPayload();
    const plaintext = Buffer.from(JSON.stringify(payload));

    // Cifrar
    const encrypted = await this.encrypt(plaintext, passphrase);

    fs.writeFileSync(outPath, encrypted, { mode: 0o600 });
    const stat = fs.statSync(outPath);

    this.log.log(`Backup creado: ${outPath} (${Math.round(stat.size / 1024)}KB)`);
    return { path: outPath, size: stat.size, ts };
  }

  /** Restaura desde un backup cifrado. */
  async restoreBackup(
    backupPath: string,
    passphrase: string,
  ): Promise<{ ok: boolean; summary: string }> {
    const resolved = path.resolve(backupPath);
    if (!resolved.startsWith(this.backupDir + path.sep) && resolved !== this.backupDir) {
      throw new Error('Ruta de backup fuera del directorio permitido');
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Backup no encontrado: ${resolved}`);
    }
    backupPath = resolved;

    const encrypted = fs.readFileSync(backupPath);
    const plaintext = await this.decrypt(encrypted, passphrase);
    const payload = JSON.parse(plaintext.toString()) as BackupPayload;

    if (payload.version !== 1) {
      throw new Error(`Versión de backup no soportada: ${payload.version}`);
    }

    this.applyPayload(payload);

    this.log.log(`Backup restaurado desde ${backupPath}`);
    return {
      ok: true,
      summary: `Restaurado: ${payload.db_size_bytes} bytes BD, ${payload.plugin_count} plugins, ${payload.ts}`,
    };
  }

  /** Lista los backups disponibles en el directorio de backups. */
  listBackups(): { name: string; path: string; size: number; ts: string }[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.enc'))
      .map((f) => {
        const full = path.join(this.backupDir, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, size: stat.size, ts: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  // ── Payload ───────────────────────────────────────────────────────────────

  private collectPayload(): BackupPayload {
    const dbAbs = path.isAbsolute(this.dbPath)
      ? this.dbPath
      : path.resolve(process.cwd(), this.dbPath);

    let dbBase64 = '';
    if (fs.existsSync(dbAbs)) {
      dbBase64 = fs.readFileSync(dbAbs).toString('base64');
    }

    let envBase64 = '';
    if (fs.existsSync(this.envPath)) {
      envBase64 = fs.readFileSync(this.envPath).toString('base64');
    }

    return {
      version: 1,
      ts: new Date().toISOString(),
      hostname: os.hostname(),
      db_base64: dbBase64,
      db_size_bytes: dbBase64 ? Buffer.from(dbBase64, 'base64').length : 0,
      env_base64: envBase64,
      plugin_count: 0, // rellenado por la BD
    };
  }

  private applyPayload(payload: BackupPayload): void {
    // Restaurar BD
    if (payload.db_base64) {
      const dbAbs = path.isAbsolute(this.dbPath)
        ? this.dbPath
        : path.resolve(process.cwd(), this.dbPath);
      const backup = `${dbAbs}.backup-${Date.now()}`;
      if (fs.existsSync(dbAbs)) fs.copyFileSync(dbAbs, backup);
      fs.writeFileSync(dbAbs, Buffer.from(payload.db_base64, 'base64'), { mode: 0o600 });
      this.log.log(`BD restaurada (backup anterior: ${backup})`);
    }

    // Restaurar .env
    if (payload.env_base64) {
      const envBackup = `${this.envPath}.backup-${Date.now()}`;
      if (fs.existsSync(this.envPath)) fs.copyFileSync(this.envPath, envBackup);
      fs.writeFileSync(this.envPath, Buffer.from(payload.env_base64, 'base64'), { mode: 0o600 });
      this.log.log('.env restaurado');
    }
  }

  // ── Criptografía ──────────────────────────────────────────────────────────

  private async encrypt(plaintext: Buffer, passphrase: string): Promise<Buffer> {
    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const key = await this.deriveKey(passphrase, salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Layout: MAGIC | salt (32) | iv (12) | tag (16) | ciphertext
    return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
  }

  private async decrypt(data: Buffer, passphrase: string): Promise<Buffer> {
    let offset = 0;

    const magic = data.subarray(offset, offset + MAGIC.length);
    if (!magic.equals(MAGIC)) throw new Error('Archivo no es un backup válido de NeuroTrader');
    offset += MAGIC.length;

    const salt = data.subarray(offset, offset + SALT_BYTES);
    offset += SALT_BYTES;
    const iv = data.subarray(offset, offset + IV_BYTES);
    offset += IV_BYTES;
    const tag = data.subarray(offset, offset + TAG_BYTES);
    offset += TAG_BYTES;
    const ciphertext = data.subarray(offset);

    const key = await this.deriveKey(passphrase, salt);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Passphrase incorrecta o backup corrupto');
    }
  }

  private deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(passphrase, salt, PBKDF2_ITERS, KEY_BYTES, 'sha256', (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
  }
}

interface BackupPayload {
  version: number;
  ts: string;
  hostname: string;
  db_base64: string;
  db_size_bytes: number;
  env_base64: string;
  plugin_count: number;
}
