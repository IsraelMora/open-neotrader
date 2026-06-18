import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { TotpService } from './totp.service';
import type { User } from '@prisma/client';
import { JwtPayload } from './strategies/jwt.strategy';

/** Par de tokens devuelto tras el login: token JWT + flag que indica si TOTP es obligatorio. */
export interface TokenPair {
  access_token: string;
  totp_required: boolean;
}

/** Gestiona el flujo completo de autenticación: registro, login, emisión de JWT y ciclo de vida TOTP. */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly totp: TotpService,
    private readonly jwt: JwtService,
  ) {}

  /** Crea el primer (y único) usuario de la instalación. */
  async register(username: string, password: string): Promise<User> {
    return this.users.create(username, password);
  }

  /** Llamado por LocalStrategy tras validar credenciales */
  issueToken(user: User): TokenPair {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,

      totp_verified: !user.totp_enabled, // ya verificado si TOTP está desactivado
    };
    return {
      access_token: this.jwt.sign(payload),
      totp_required: user.totp_enabled,
    };
  }

  /** Emite token con totp_verified=true tras validar el código OTP */
  verifyTotpAndUpgrade(user: User, code: string): string {
    if (!user.totp_enabled || !user.totp_secret) {
      throw new BadRequestException('TOTP no está activado');
    }
    const ok = this.totp.verify(user.totp_secret, code);
    if (!ok) throw new UnauthorizedException('Código TOTP inválido');

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,

      totp_verified: true,
    };
    return this.jwt.sign(payload);
  }

  /** Verifica código de respaldo en lugar de TOTP */
  async verifyBackupCode(user: User, code: string): Promise<string> {
    const ok = await this.users.consumeBackupCode(user, code.toUpperCase());
    if (!ok) throw new UnauthorizedException('Código de respaldo inválido o ya usado');

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,

      totp_verified: true,
    };
    return this.jwt.sign(payload);
  }

  /** Setup: genera secreto temporal (no guardado aún), devuelve QR */
  async setupTotp(user: User): Promise<{ secret: string; qr_svg: string }> {
    const secret = this.totp.generateSecret();
    // Guarda el secreto en estado pending (totp_enabled=false)
    await this.users.saveTotpSecret(user.id, secret);
    const qr_svg = await this.totp.generateQrSvg(user.username, secret);
    return { secret, qr_svg };
  }

  /** Activa TOTP: valida el primer código, genera backup codes */
  async activateTotp(user: User, code: string): Promise<{ backup_codes: string[] }> {
    if (!user.totp_secret) {
      throw new BadRequestException('Primero llama a /auth/totp/setup');
    }
    if (user.totp_enabled) {
      throw new ConflictException('TOTP ya está activado');
    }
    const ok = this.totp.verify(user.totp_secret, code);
    if (!ok) throw new UnauthorizedException('Código TOTP inválido');

    await this.users.enableTotp(user.id);
    const rawCodes = this.totp.generateBackupCodes();
    const backup_codes = await this.users.saveBackupCodes(user.id, rawCodes);
    return { backup_codes };
  }

  /** Desactiva TOTP tras validar el código actual y borra el secreto y los backup codes. */
  async disableTotp(user: User, code: string): Promise<void> {
    if (!user.totp_enabled || !user.totp_secret) {
      throw new BadRequestException('TOTP no está activado');
    }
    const ok = this.totp.verify(user.totp_secret, code);
    if (!ok) throw new UnauthorizedException('Código TOTP inválido');
    await this.users.disableTotp(user.id);
  }
}
