import { Module } from '@nestjs/common';
import { RegistryService } from './registry.service';
import { RegistryController } from './registry.controller';
import { PluginsModule } from '../plugins/plugins.module';
import { StoreModule } from '../store/store.module';

@Module({
  imports: [PluginsModule, StoreModule],
  providers: [RegistryService],
  controllers: [RegistryController],
})
export class RegistryModule {}
