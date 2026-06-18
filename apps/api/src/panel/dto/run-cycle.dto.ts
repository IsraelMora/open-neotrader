import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RunCycleDto {
  @ApiPropertyOptional({ default: false, description: 'Si true, ejecuta plugins sin LLM' })
  @IsBoolean()
  @IsOptional()
  dry_run?: boolean;

  @ApiPropertyOptional({
    description:
      'Prompt inicial del ciclo. Si no se proporciona, los skills activos definen el contexto.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(4000)
  prompt?: string;
}
