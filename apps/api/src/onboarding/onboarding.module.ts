import { Module } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { OnboardingController } from './onboarding.controller';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { PluginsModule } from '../plugins/plugins.module';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { KvService } from '../common/kv.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

@Module({
  imports: [UsersModule, AuthModule, PluginsModule, LlmModule, PrismaModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, KvService, TotpRequiredGuard],
})
export class OnboardingModule {}
