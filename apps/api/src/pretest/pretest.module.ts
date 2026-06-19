import { Module } from '@nestjs/common';
import { PretestService } from './pretest.service';
import { PretestController } from './pretest.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';
import { ProvidersModule } from '../providers/providers.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    PrismaModule,
    SandboxModule,
    PluginsModule,
    ContextMemoryModule,
    ProvidersModule,
    AgentsModule,
  ],
  providers: [PretestService],
  controllers: [PretestController],
  exports: [PretestService],
})
export class PretestModule {}
