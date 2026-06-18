import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class SetCredentialDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  env: string;

  @IsString()
  @IsOptional()
  @MaxLength(512)
  value?: string;
}
