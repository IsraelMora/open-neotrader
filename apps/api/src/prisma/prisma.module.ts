import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { MigrationRunnerService } from './migration-runner.service';

@Global()
@Module({
  providers: [PrismaService, MigrationRunnerService],
  exports: [PrismaService],
})
export class PrismaModule {}
