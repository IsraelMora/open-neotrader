/**
 * WebSearchModule — leaf module. ConfigService comes from the app-wide global
 * ConfigModule (isGlobal:true in app.module.ts), so no imports are needed here.
 * Exports WebSearchService so AgentsModule can inject it @Optional() for the
 * kernel__web_search tool.
 */
import { Module } from '@nestjs/common';
import { WebSearchService } from './web-search.service';

@Module({
  providers: [WebSearchService],
  exports: [WebSearchService],
})
export class WebSearchModule {}
