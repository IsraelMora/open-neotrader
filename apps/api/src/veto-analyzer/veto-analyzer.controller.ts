import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import {
  VetoAnalyzerService,
  type BackfillSummary,
  type VetoMetricsReport,
  type PluginValueReport,
} from './veto-analyzer.service';
import { VetoMetricsQueryDto } from './dto/veto-metrics-query.dto';
import { VetoBackfillDto } from './dto/veto-backfill.dto';

/** Read-side net veto value metrics: fixed-horizon counterfactual P&L over the veto decision ledger. */
@ApiTags('veto-metrics')
@ApiBearerAuth()
@Controller('veto-metrics')
export class VetoAnalyzerController {
  constructor(private readonly vetoAnalyzer: VetoAnalyzerService) {}

  @Get()
  @ApiOperation({ summary: 'Net veto value aggregate over already-evaluated veto decisions' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  getMetrics(@Query() q: VetoMetricsQueryDto): Promise<VetoMetricsReport> {
    return this.vetoAnalyzer.getMetrics({
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @Get('plugin-value')
  @ApiOperation({
    summary: 'Per-plugin raw signal value attribution over already-evaluated veto decisions',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  getPluginValue(@Query() q: VetoMetricsQueryDto): Promise<PluginValueReport> {
    return this.vetoAnalyzer.getPluginValue({
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @Post('backfill')
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({
    summary: 'Backfill counterfactual P&L for unevaluated veto decisions (requires TOTP)',
  })
  backfill(@Body() opts: VetoBackfillDto): Promise<BackfillSummary> {
    return this.vetoAnalyzer.backfill(opts);
  }
}
