import { IsString, MinLength, MaxLength, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'operador' })
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  username: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  password: string;
}

export class TotpVerifyDto {
  @ApiProperty({ description: 'Código de 6 dígitos del autenticador' })
  @IsString()
  @Length(6, 6)
  code: string;
}

export class TotpActivateDto {
  @ApiProperty({ description: 'Primer código válido para confirmar el setup' })
  @IsString()
  @Length(6, 6)
  code: string;
}

export class BackupCodeDto {
  @ApiProperty({ description: 'Código de respaldo de 8 caracteres' })
  @IsString()
  @Length(8, 8)
  code: string;
}
