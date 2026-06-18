import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TotpService } from './totp.service';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TotpRequiredGuard } from './guards/totp-required.guard';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: cfg.get<string>('JWT_EXPIRES_IN', '8h') as StringValue },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    AuthService,
    TotpService,
    LocalStrategy,
    JwtStrategy,
    JwtAuthGuard,
    TotpRequiredGuard,
  ],
  controllers: [AuthController],
  exports: [AuthService, TotpService, JwtAuthGuard, TotpRequiredGuard, JwtModule],
})
export class AuthModule {}
