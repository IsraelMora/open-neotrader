/**
 * TradeIntentController — REST endpoints for HITL paper trade-execution.
 *
 * GET  /trade-intents             — list all (optional ?status= filter)
 * POST /trade-intents/:id/approve — approve and paper-execute (TotpRequiredGuard)
 * POST /trade-intents/:id/reject  — reject with reason (TotpRequiredGuard)
 *
 * Approve and reject are money-adjacent actions and therefore require TOTP.
 *
 * REAL-MONEY EXECUTION IS HARD-DISABLED at the service layer.
 */
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength, MinLength } from 'class-validator';
import { TradeIntentService } from './trade-intent.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

class ApproveIntentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  decided_by!: string;
}

class RejectIntentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  decided_by!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}

@ApiTags('trade-intents')
@ApiBearerAuth()
@Controller('trade-intents')
export class TradeIntentController {
  constructor(private readonly service: TradeIntentService) {}

  @Get()
  @ApiOperation({ summary: 'List trade intents (optional ?status= filter)' })
  list(@Query('status') status?: string) {
    return this.service.list(status);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({ summary: 'Approve and paper-execute a pending trade intent (TOTP required)' })
  approve(@Param('id') id: string, @Body() dto: ApproveIntentDto) {
    return this.service.approve(id, dto.decided_by);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({ summary: 'Reject a pending trade intent (TOTP required)' })
  reject(@Param('id') id: string, @Body() dto: RejectIntentDto) {
    return this.service.reject(id, dto.decided_by, dto.reason);
  }
}
