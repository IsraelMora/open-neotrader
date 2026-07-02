import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { TradeIntentService } from './trade-intent.service';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

/**
 * Operator-facing execution policy. Lets the owner "configure once":
 * autonomous on/off, risk knobs, and the deliberate real-money opt-in.
 *
 * Real-money safety does NOT depend SOLELY on this endpoint's downstream checks —
 * even with real=true the order only fires when a broker is set (triple condition)
 * AND it passes the automated risk gates + notional ceiling inside the execution
 * service. But flipping real=true (or autonomous=true) is itself a money-adjacent
 * action — same class as TradeIntentController approve/reject — so PATCH requires
 * TOTP (H1).
 */
class UpdateExecutionPolicyDto {
  @IsOptional() @IsBoolean() autonomous?: boolean;
  @IsOptional() @IsBoolean() real?: boolean;
  @IsOptional() @IsString() broker_plugin_id?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) max_position_pct?: number;
  @IsOptional() @IsInt() @Min(1) max_open_positions?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) max_drawdown_halt_pct?: number;
  @IsOptional() @IsNumber() @Min(0) max_order_notional?: number;
}

@ApiTags('execution')
@ApiBearerAuth()
@Controller('execution')
export class ExecutionController {
  constructor(private readonly svc: TradeIntentService) {}

  @Get('config')
  @ApiOperation({ summary: 'Política de ejecución actual (autonomía, riesgo, real on/off)' })
  getConfig() {
    return this.svc.getPolicy();
  }

  @Patch('config')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({
    summary: 'Actualiza la política de ejecución (solo los campos enviados; TOTP requerido)',
  })
  setConfig(@Body() dto: UpdateExecutionPolicyDto) {
    return this.svc.setPolicy(dto);
  }

  /**
   * Global real-money kill-switch (see real-execution-halt.util.ts). Halts NEW real
   * long/short entries; exit/hold and the entire paper path are unaffected. The switch
   * is auto-tripped by the system when unhealthy (reconciliation circuit breaker,
   * broker position drift, repeated order-submit failures) and can ONLY be cleared by
   * a human operator via clearRealHalt below — read-only, no TOTP required.
   */
  @Get('real-halt')
  @ApiOperation({ summary: 'Estado del kill-switch de ejecución real (halted + motivo)' })
  getRealHalt() {
    return this.svc.getRealExecutionHaltStatus();
  }

  /**
   * Clears the real-money kill-switch. Re-arming real trading after an automated halt
   * is money-adjacent — same class as PATCH /execution/config — so it requires TOTP.
   */
  @Post('real-halt/clear')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({
    summary: 'Limpia el kill-switch de ejecución real (solo humano, TOTP requerido)',
  })
  clearRealHalt() {
    return this.svc.clearRealExecutionHalt();
  }
}
