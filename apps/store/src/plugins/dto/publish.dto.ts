import { IsString, IsNotEmpty, IsBase64 } from 'class-validator';

/** Cuerpo de la petición `POST /api/plugins` para publicar un plugin. */
export class PublishDto {
  @IsString() @IsNotEmpty() manifestToml!: string;
  @IsString() @IsBase64() payloadBase64!: string;
}
