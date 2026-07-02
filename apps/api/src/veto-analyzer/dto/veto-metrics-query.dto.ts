import { IsDateString, IsOptional } from 'class-validator';

/** Optional time window filter for GET /veto-metrics — mirrors AuditQueryDto's from/to shape. */
export class VetoMetricsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
