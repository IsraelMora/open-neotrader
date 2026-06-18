import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CredentialsService } from './credentials.service';
import { SetCredentialDto } from './dto/set-credential.dto';

/** Endpoints de gestión de credenciales: listado enmascarado y escritura en .env. */
@ApiTags('credentials')
@ApiBearerAuth()
@Controller('credentials')
export class CredentialsController {
  constructor(private readonly svc: CredentialsService) {}

  @Get()
  @ApiOperation({
    summary: 'Estado enmascarado de todas las credenciales (nunca devuelve valores)',
  })
  list() {
    return this.svc.list();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Guardar o borrar una credencial en .env (valor vacío = borrar)' })
  async set(@Body() dto: SetCredentialDto) {
    this.svc.set(dto.env, dto.value);
    return this.svc.list();
  }
}
