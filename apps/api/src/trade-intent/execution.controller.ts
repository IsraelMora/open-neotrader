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
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { TradeIntentService } from './trade-intent.service';
import { RealBrokerReconciliationService } from '../real-reconciliation/real-broker-reconciliation.service';
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

/** Body for the operator-only broker-position adoption endpoint. */
class AdoptPositionDto {
  @IsString() @IsNotEmpty() symbol!: string;
  @IsOptional() @IsString() note?: string;
}

@ApiTags('execution')
@ApiBearerAuth()
@Controller('execution')
export class ExecutionController {
  constructor(
    private readonly svc: TradeIntentService,
    private readonly reconciliation: RealBrokerReconciliationService,
  ) {}

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

  /**
   * Adopts a REAL broker position that exists at the broker with no explaining
   * fill history into the ledger (see RealBrokerReconciliationService.
   * adoptBrokerPosition). This resolves a BROKER_DRIFT halt caused by legacy
   * fire-and-forget orders: without it, clearing the kill-switch is futile
   * because the next sync re-detects the unexplained position and re-trips.
   *
   * Money-ledger admin action — same class as clearRealHalt above, so it
   * requires TOTP. It NEVER fabricates: the service refuses if the symbol is not
   * currently reported by the broker. Adopting does NOT clear the halt itself
   * (still a human/TOTP action) — it removes the reason drift re-trips.
   */
  @Post('adopt-position')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TotpRequiredGuard)
  @ApiOperation({
    summary:
      'Adopta una posición real del broker sin historial de fills al ledger (solo humano, TOTP requerido)',
  })
  async adoptPosition(@Body() dto: AdoptPositionDto) {
    const brokerPluginId = await this.reconciliation.getActiveBrokerPluginId();
    return this.reconciliation.adoptBrokerPosition(dto.symbol, brokerPluginId, dto.note);
  }
}
