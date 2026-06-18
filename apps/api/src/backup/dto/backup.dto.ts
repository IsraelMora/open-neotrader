import { IsString, MinLength, MaxLength } from 'class-validator';

export class CreateBackupDto {
  @IsString()
  @MinLength(12)
  @MaxLength(1024)
  passphrase!: string;
}

export class RestoreBackupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  path!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(1024)
  passphrase!: string;
}
