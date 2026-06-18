import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { UsersService } from '../../users/users.service';

/** Estrategia Passport local que valida username/password y devuelve el usuario al AuthController. */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly users: UsersService) {
    super({ usernameField: 'username' });
  }

  async validate(username: string, password: string) {
    const user = await this.users.findByUsername(username);
    if (!user) throw new UnauthorizedException('Credenciales inválidas');
    const ok = await this.users.validatePassword(user, password);
    if (!ok) throw new UnauthorizedException('Credenciales inválidas');
    return user;
  }
}
