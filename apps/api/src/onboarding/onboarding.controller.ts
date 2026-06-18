import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import { OnboardingService } from './onboarding.service';

class CreateAdminDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

/** Endpoints del wizard de onboarding: estado, creación del admin, completado y reset. */
@ApiTags('onboarding')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('status')
  @Public()
  @ApiOperation({ summary: 'Estado del wizard de primera instalación (público)' })
  status() {
    return this.onboarding.getStatus();
  }

  @Post('admin')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crear el usuario de la instalación (solo si no hay ninguno aún)',
    description: 'Endpoint público únicamente durante la primera instalación. Devuelve token JWT.',
  })
  createAdmin(@Body() dto: CreateAdminDto) {
    return this.onboarding.createAdmin(dto.username, dto.password);
  }

  @Post('complete')
  @ApiBearerAuth()
  @UseGuards(TotpRequiredGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Marcar onboarding como completado' })
  async complete() {
    await this.onboarding.markComplete();
  }

  @Post('reset')
  @ApiBearerAuth()
  @UseGuards(TotpRequiredGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Resetear onboarding — solo en desarrollo' })
  async reset() {
    if (process.env['NODE_ENV'] === 'production') {
      throw new ForbiddenException('Reset no disponible en producción');
    }
    await this.onboarding.reset();
  }
}
