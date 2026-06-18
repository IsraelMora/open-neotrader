import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { LlmService, LlmRequest, type CustomLlmProvider } from './llm.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

/** Endpoints de gestión del LLM: completar contexto, configurar modelo/backend y administrar providers custom. */
@ApiTags('llm')
@ApiBearerAuth()
@UseGuards(TotpRequiredGuard)
@Controller('llm')
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @Post('complete')
  @ApiOperation({ summary: 'Enviar contexto al LLM y obtener análisis + tool calls' })
  complete(@Body() req: LlmRequest) {
    return this.llm.complete(req);
  }

  @Get('config')
  @ApiOperation({ summary: 'Configuración activa del LLM: modelo, backend, capacidades' })
  getConfig() {
    return this.llm.getConfig();
  }

  @Patch('config')
  @ApiOperation({ summary: 'Cambiar modelo, backend o activar provider custom en runtime' })
  patchConfig(@Body() body: { model?: string; backend?: string; custom_provider_id?: string }) {
    return this.llm.patchConfig(body);
  }

  // ── Providers custom (OpenAI-compatible) ───────────────────────────────────

  @Get('providers')
  @ApiOperation({ summary: 'Lista los providers LLM custom configurados por el usuario' })
  listProviders() {
    return { providers: this.llm.getCustomProviders() };
  }

  @Post('providers')
  @ApiOperation({
    summary: 'Añadir provider LLM custom con formato OpenAI-compatible',
    description:
      'Funciona con cualquier API compatible con OpenAI: Groq, OpenRouter, Together.ai, Mistral, ' +
      'Ollama, LM Studio, Perplexity, Fireworks.ai, Anyscale, etc. ' +
      'Campos: { name, base_url, api_key_env, default_model, description? }. ' +
      'api_key_env es el nombre de la variable de entorno donde está la API key.',
  })
  addProvider(@Body() body: Omit<CustomLlmProvider, 'id'> & { id?: string }) {
    return this.llm.addCustomProvider(body);
  }

  @Delete('providers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar provider custom' })
  removeProvider(@Param('id') id: string): void {
    this.llm.removeCustomProvider(id);
  }
}
