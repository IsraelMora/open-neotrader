import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublishersService {
  constructor(private readonly prisma: PrismaService) {}
  async setName(id: string, publicKey: string, displayName: string | null) {
    await this.prisma.publisher.upsert({
      where: { id },
      create: { id, publicKey, displayName },
      update: { displayName },
    });
    return { id, displayName };
  }
}
