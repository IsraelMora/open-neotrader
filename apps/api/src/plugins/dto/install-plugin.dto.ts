import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InstallPluginDto {
  @ApiProperty({ example: 'https://github.com/user/plugin/archive/main.zip' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  source: string;
}
