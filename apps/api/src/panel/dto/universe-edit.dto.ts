import { IsString, IsNotEmpty, IsIn, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UniverseEditDto {
  @ApiProperty({ enum: ['add', 'remove'] })
  @IsString()
  @IsIn(['add', 'remove'])
  action: 'add' | 'remove';

  @ApiProperty({ example: 'AAPL', description: 'Símbolo del activo (se normaliza a mayúsculas)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  symbol: string;

  @ApiPropertyOptional({
    description:
      'Tipo de activo — libre, lo interpreta el plugin provider (ej. equity, crypto, futures, forex)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(32)
  kind?: string;

  @ApiPropertyOptional({ description: 'Contexto del activo para el LLM' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;
}
