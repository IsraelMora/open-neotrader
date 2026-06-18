import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, IsIn, IsOptional } from 'class-validator';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import { ContextMemoryService } from './context-memory.service';

class SetFlagDto {
  @IsString()
  key!: string;

  value!: string | number | boolean;

  @IsIn(['user', 'llm'])
  set_by!: 'user' | 'llm';

  @IsOptional()
  @IsString()
  note?: string;
}

@ApiTags('context-memory')
@ApiBearerAuth()
@UseGuards(TotpRequiredGuard)
@Controller('context-memory')
export class ContextMemoryController {
  constructor(private readonly mem: ContextMemoryService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener la memoria de contexto completa' })
  get() {
    return this.mem.get();
  }

  @Get('context')
  @ApiOperation({ summary: 'Contexto serializado para inyectar al LLM' })
  async context() {
    return { context: await this.mem.toContextString() };
  }

  @Post('flags')
  @ApiOperation({ summary: 'Crear o actualizar un flag persistente' })
  async setFlag(@Body() dto: SetFlagDto) {
    await this.mem.setFlag(dto.key, dto.value, dto.set_by, dto.note);
    return { ok: true };
  }

  @Delete('flags/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un flag persistente' })
  async deleteFlag(@Param('key') key: string) {
    await this.mem.deleteFlag(key);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Resetear toda la memoria de contexto' })
  async reset() {
    await this.mem.reset();
  }
}
