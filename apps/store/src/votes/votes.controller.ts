import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { VotesService } from './votes.service';
import { VoteDto } from './dto/vote.dto';
import { ReportDto } from './dto/report.dto';

/** Controlador REST para votos y reportes de plugins (`/api/plugins/:id`). */
@Controller('plugins/:id')
export class VotesController {
  constructor(private readonly votes: VotesService) {}

  /**
   * Registra o actualiza el voto del publisher autenticado sobre un plugin.
   *
   * @param id  - ID interno del plugin.
   * @param pub - Publisher autenticado.
   * @param dto - Tipo de voto: `like` o `dislike`.
   */
  @Post('vote')
  @UseGuards(SignatureGuard)
  vote(
    @Param('id') id: string,
    @Publisher() pub: { id: string; publicKey: string },
    @Body() dto: VoteDto,
  ) {
    return this.votes.vote(id, pub.id, pub.publicKey, dto.kind);
  }

  /**
   * Registra o actualiza el reporte del publisher autenticado sobre un plugin.
   *
   * @param id  - ID interno del plugin.
   * @param pub - Publisher autenticado.
   * @param dto - Motivo del reporte (máximo 500 caracteres).
   */
  @Post('report')
  @UseGuards(SignatureGuard)
  report(
    @Param('id') id: string,
    @Publisher() pub: { id: string; publicKey: string },
    @Body() dto: ReportDto,
  ) {
    return this.votes.report(id, pub.id, pub.publicKey, dto.reason);
  }
}
