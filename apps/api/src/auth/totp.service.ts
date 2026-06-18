import { Injectable } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import * as crypto from 'crypto';

const ISSUER = 'NeuroTrader';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;

@Injectable()
export class TotpService {
  generateSecret(): string {
    return speakeasy.generateSecret({ length: 20 }).base32;
  }

  async generateQrSvg(username: string, secret: string): Promise<string> {
    const uri = speakeasy.otpauthURL({
      secret,
      label: username,
      issuer: ISSUER,
      encoding: 'base32',
    });
    return qrcode.toString(uri, { type: 'svg', margin: 1 });
  }

  verify(secret: string, token: string): boolean {
    return speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
  }

  generateBackupCodes(): string[] {
    return Array.from({ length: BACKUP_CODE_COUNT }, () =>
      crypto
        .randomBytes(BACKUP_CODE_LENGTH / 2)
        .toString('hex')
        .toUpperCase(),
    );
  }
}
