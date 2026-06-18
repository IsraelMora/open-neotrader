import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddSkillDto {
  @ApiProperty({ example: 'analyze_sentiment', description: 'Nombre de la skill (único)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  @ApiProperty({ description: 'Descripción que el LLM recibirá como contexto de esta skill' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description: string;
}
