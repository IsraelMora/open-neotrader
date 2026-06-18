import { Injectable } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import * as crypto from 'crypto';

const ISSUER = 'NeuroTrader';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;

/** Encapsula las operaciones criptográficas de TOTP: generación de secretos, QR, verificación y backup codes. */
@Injectable()
export class TotpService {
  /** Genera un secreto TOTP base32 de 20 bytes. */
  generateSecret(): string {
    return speakeasy.generateSecret({ length: 20 }).base32;
  }

  /** Genera el SVG del código QR a escanear con el autenticador. */
  async generateQrSvg(username: string, secret: string): Promise<string> {
    const uri = speakeasy.otpauthURL({
      secret,
      label: username,
      issuer: ISSUER,
      encoding: 'base32',
    });
    return qrcode.toString(uri, { type: 'svg', margin: 1 });
  }

  /** Verifica un código TOTP con ventana de ±1 intervalo de 30s. */
  verify(secret: string, token: string): boolean {
    return speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
  }

  /** Genera 10 códigos de respaldo hexadecimales de 8 caracteres en mayúsculas. */
  generateBackupCodes(): string[] {
    return Array.from({ length: BACKUP_CODE_COUNT }, () =>
      crypto
        .randomBytes(BACKUP_CODE_LENGTH / 2)
        .toString('hex')
        .toUpperCase(),
    );
  }
}
