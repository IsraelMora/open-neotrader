import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';
import { PanelService } from '../panel/panel.service';
import type { ReflectionTurnResult } from './agents.service';

/**
 * Agents controller — exposes kernel-level agent operations.
 *
 * POST /agents/reflect  — triggers a manual reflection turn.
 *   Requires JWT authentication + TOTP second factor.
 *   Delegates to PanelService.reflectNow() which guards against concurrent cycles.
 *   Returns 409 ConflictException if a cycle is running; 200 with ReflectionTurnResult otherwise.
 */
@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(private readonly panel: PanelService) {}

  @Post('reflect')
  @UseGuards(JwtAuthGuard, TotpRequiredGuard)
  @ApiOperation({ summary: 'Trigger a manual reflection turn (requires TOTP)' })
  async reflect(): Promise<ReflectionTurnResult> {
    // Delegates to PanelService so the concurrency guard (runState.running) is respected.
    // Reuses the existing panel→agents dependency edge; no new module cycle is introduced.
    return this.panel.reflectNow();
  }
}
