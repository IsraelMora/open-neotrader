import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Get,
  Delete,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TotpRequiredGuard } from './guards/totp-required.guard';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { RegisterDto, TotpVerifyDto, TotpActivateDto, BackupCodeDto } from './dto/auth.dto';
import type { User } from '@prisma/client';

@ApiTags('auth')
@Throttle({ auth: { ttl: 60_000, limit: 10 } })
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Registrar primer operador (mono-operador)' })
  async register(@Body() dto: RegisterDto) {
    const user = await this.auth.register(dto.username, dto.password);
    return { id: user.id, username: user.username };
  }

  @Public()
  @UseGuards(AuthGuard('local'))
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login con usuario y contraseña' })
  login(@CurrentUser() user: User) {
    return this.auth.issueToken(user);
  }

  @ApiBearerAuth()
  @Post('totp/setup')
  @ApiOperation({ summary: 'Iniciar configuración de TOTP (devuelve QR)' })
  async totpSetup(@CurrentUser() user: User) {
    return this.auth.setupTotp(user);
  }

  @ApiBearerAuth()
  @Post('totp/activate')
  @ApiOperation({ summary: 'Confirmar primer código y activar TOTP; devuelve backup codes' })
  async totpActivate(@CurrentUser() user: User, @Body() dto: TotpActivateDto) {
    return this.auth.activateTotp(user, dto.code);
  }

  @Public()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('totp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verificar código TOTP y elevar JWT a totp_verified=true' })
  totpVerify(@CurrentUser() user: User, @Body() dto: TotpVerifyDto) {
    const access_token = this.auth.verifyTotpAndUpgrade(user, dto.code);
    return { access_token };
  }

  @Public()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('totp/backup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Usar código de respaldo en lugar de TOTP' })
  async totpBackup(@CurrentUser() user: User, @Body() dto: BackupCodeDto) {
    const access_token = await this.auth.verifyBackupCode(user, dto.code);
    return { access_token };
  }

  @ApiBearerAuth()
  @UseGuards(TotpRequiredGuard)
  @Delete('totp')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desactivar TOTP (requiere código actual)' })
  async totpDisable(@CurrentUser() user: User, @Body() dto: TotpVerifyDto) {
    await this.auth.disableTotp(user, dto.code);
  }

  @ApiBearerAuth()
  @UseGuards(TotpRequiredGuard)
  @Get('me')
  @ApiOperation({ summary: 'Datos del operador autenticado' })
  me(@CurrentUser() user: User) {
    return {
      id: user.id,
      username: user.username,
      totp_enabled: user.totp_enabled,
      created_at: user.created_at,
    };
  }
}
