import { Module, forwardRef } from '@nestjs/common';
import { PretestService } from './pretest.service';
import { PretestController } from './pretest.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ContextMemoryModule } from '../context-memory/context-memory.module';
import { ProvidersModule } from '../providers/providers.module';
import { AgentsModule } from '../agents/agents.module';
import { KvService } from '../common/kv.service';

@Module({
  imports: [
    PrismaModule,
    SandboxModule,
    PluginsModule,
    ContextMemoryModule,
    ProvidersModule,
    // forwardRef breaks the circular dependency:
    // PretestModule → forwardRef(AgentsModule) ↔ AgentsModule → forwardRef(PretestModule)
    forwardRef(() => AgentsModule),
  ],
  providers: [PretestService, KvService],
  controllers: [PretestController],
  exports: [PretestService],
})
export class PretestModule {}
