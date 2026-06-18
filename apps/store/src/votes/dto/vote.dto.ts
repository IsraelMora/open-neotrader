import { IsIn } from 'class-validator';
/** Cuerpo de la petición `POST /api/plugins/:id/vote`. */
export class VoteDto {
  @IsIn(['like', 'dislike']) kind!: 'like' | 'dislike';
}
