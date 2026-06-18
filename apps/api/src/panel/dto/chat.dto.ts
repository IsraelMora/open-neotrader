import { IsString, IsNotEmpty, IsOptional, IsArray, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatDto {
  @ApiProperty({ description: 'Pregunta o contexto textual — nunca series de precios' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  question: string;

  @ApiPropertyOptional({ description: 'Historial de mensajes previos' })
  @IsArray()
  @IsOptional()
  history?: unknown[];
}
