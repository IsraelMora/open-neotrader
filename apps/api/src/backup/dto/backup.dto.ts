import { IsString, MinLength, MaxLength } from 'class-validator';

/** Cuerpo para crear un backup cifrado. La passphrase debe tener mínimo 12 caracteres. */
export class CreateBackupDto {
  @IsString()
  @MinLength(12)
  @MaxLength(1024)
  passphrase!: string;
}

/** Cuerpo para restaurar un backup: ruta del archivo .enc y passphrase de descifrado. */
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
