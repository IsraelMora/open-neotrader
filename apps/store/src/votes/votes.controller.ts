import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { VotesService } from './votes.service';
import { VoteDto } from './dto/vote.dto';
import { ReportDto } from './dto/report.dto';

@Controller('plugins/:id')
export class VotesController {
  constructor(private readonly votes: VotesService) {}

  @Post('vote')
  @UseGuards(SignatureGuard)
  vote(
    @Param('id') id: string,
    @Publisher() pub: { id: string; publicKey: string },
    @Body() dto: VoteDto,
  ) {
    return this.votes.vote(id, pub.id, pub.publicKey, dto.kind);
  }

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
