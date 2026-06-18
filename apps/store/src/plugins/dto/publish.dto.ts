import { IsString, IsNotEmpty, IsBase64 } from 'class-validator';

export class PublishDto {
  @IsString() @IsNotEmpty() manifestToml!: string;
  @IsString() @IsBase64() payloadBase64!: string;
}
