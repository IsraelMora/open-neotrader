import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { User } from '@prisma/client';

export type { User };

const BCRYPT_ROUNDS = 12;

/** Repositorio de usuarios: creación (mono-usuario), consulta, validación de contraseña y gestión de TOTP/backup codes. */
@Injectable()
export class UsersService {
  constructor(private readonly db: PrismaService) {}

  /** Crea el único usuario permitido. Lanza ConflictException si ya existe uno. */
  async create(username: string, password: string): Promise<User> {
    // Un solo usuario por instalación (local-first)
    if ((await this.db.user.count()) > 0) {
      throw new ConflictException(
        'Ya existe un usuario en esta instalación. OpenNeoTrader es monousuario.',
      );
    }
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return this.db.user.create({ data: { username, password_hash } });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { username, is_active: true } });
  }

  async findById(id: string): Promise<User> {
    const user = await this.db.user.findUnique({ where: { id, is_active: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  count(): Promise<number> {
    return this.db.user.count();
  }

  validatePassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.password_hash);
  }

  async saveTotpSecret(userId: string, secret: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { totp_secret: secret, totp_enabled: false },
    });
  }

  async enableTotp(userId: string): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { totp_enabled: true } });
  }

  async disableTotp(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { totp_secret: null, totp_enabled: false, backup_codes_hash: null },
    });
  }

  async saveBackupCodes(userId: string, codes: string[]): Promise<string[]> {
    const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, BCRYPT_ROUNDS)));
    await this.db.user.update({
      where: { id: userId },
      data: { backup_codes_hash: hashes.join('|') },
    });
    return codes;
  }

  /** Verifica y consume un backup code (lo elimina del set al usarlo). Devuelve false si no es válido. */
  async consumeBackupCode(user: User, code: string): Promise<boolean> {
    if (!user.backup_codes_hash) return false;
    const hashes = user.backup_codes_hash.split('|');
    const results = await Promise.all(hashes.map((h) => bcrypt.compare(code, h)));
    const matchIdx = results.indexOf(true);
    if (matchIdx === -1) return false;
    hashes.splice(matchIdx, 1);
    await this.db.user.update({
      where: { id: user.id },
      data: { backup_codes_hash: hashes.length > 0 ? hashes.join('|') : null },
    });
    return true;
  }
}
