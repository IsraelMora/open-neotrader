import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
/** Cuerpo de la petición `POST /api/plugins/:id/report`. */
export class ReportDto {
  @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}
