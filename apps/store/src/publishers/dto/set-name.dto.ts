import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/** Cuerpo de la petición `POST /api/publishers/name`. */
export class SetNameDto {
  @ValidateIf((o: SetNameDto) => o.displayName !== null)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  displayName!: string | null;
}
