import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { PublishersService } from './publishers.service';
import { SetNameDto } from './dto/set-name.dto';

/** Controlador REST para la gestión de publishers (`/api/publishers`). */
@Controller('publishers')
export class PublishersController {
  constructor(private readonly publishers: PublishersService) {}

  /**
   * Establece o actualiza el nombre público del publisher autenticado.
   *
   * @param pub - Publisher autenticado extraído por `@Publisher()`.
   * @param dto - Cuerpo con el nombre a asignar (máximo 40 caracteres; `null` para borrar).
   */
  @Post('name')
  @UseGuards(SignatureGuard)
  setName(
    @Publisher() pub: { id: string; publicKey: string },
    @Body() dto: SetNameDto,
  ) {
    return this.publishers.setName(pub.id, pub.publicKey, dto.displayName);
  }
}
