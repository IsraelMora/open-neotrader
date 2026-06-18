import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { PublishersService } from './publishers.service';
import { SetNameDto } from './dto/set-name.dto';

@Controller('publishers')
export class PublishersController {
  constructor(private readonly publishers: PublishersService) {}
  @Post('name')
  @UseGuards(SignatureGuard)
  setName(
    @Publisher() pub: { id: string; publicKey: string },
    @Body() dto: SetNameDto,
  ) {
    return this.publishers.setName(pub.id, pub.publicKey, dto.displayName);
  }
}
