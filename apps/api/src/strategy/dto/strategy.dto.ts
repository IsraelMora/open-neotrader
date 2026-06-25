import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  IsBoolean,
  IsIn,
  MaxLength,
} from 'class-validator';

export class CreateStrategyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Snapshot de claves KV. Si se omite, se captura la configuración actual. */
  @IsOptional()
  @IsObject()
  config?: Record<string, string>;

  @IsOptional()
  @IsIn(['test', 'live'])
  mode?: 'test' | 'live';
}

export class UpdateStrategyDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, string>;

  @IsOptional()
  @IsIn(['test', 'live'])
  mode?: 'test' | 'live';
}

export class SetActiveDto {
  @IsBoolean()
  active!: boolean;
}
