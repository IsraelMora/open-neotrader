import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SignatureGuard } from '../auth/signature.guard';
import { Publisher } from '../auth/publisher.decorator';
import { PluginsService } from './plugins.service';
import { PublishDto } from './dto/publish.dto';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  list(
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.plugins.list({
      type,
      q,
      sort,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':publisherId/:manifestId/:version/download')
  download(
    @Param('publisherId') p: string,
    @Param('manifestId') m: string,
    @Param('version') v: string,
  ) {
    return this.plugins.download(p, m, v);
  }

  @Get(':publisherId/:manifestId')
  detail(@Param('publisherId') p: string, @Param('manifestId') m: string) {
    return this.plugins.detail(p, m);
  }

  @Post()
  @UseGuards(SignatureGuard)
  async publish(
    @Publisher() pub: { id: string; publicKey: string },
    @Body() dto: PublishDto,
  ) {
    return this.plugins.publish(
      pub.id,
      pub.publicKey,
      dto.manifestToml,
      dto.payloadBase64,
    );
  }
}
