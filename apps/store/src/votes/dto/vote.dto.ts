import { IsIn } from 'class-validator';
export class VoteDto {
  @IsIn(['like', 'dislike']) kind!: 'like' | 'dislike';
}
