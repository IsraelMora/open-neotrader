import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsNumber,
  Min,
  IsEnum,
  IsOptional,
} from 'class-validator';

export class PlaceOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  symbol!: string;

  @IsNumber()
  @Min(0.000001)
  qty!: number;

  @IsEnum(['buy', 'sell'])
  side!: 'buy' | 'sell';

  @IsEnum(['market', 'limit'])
  type!: 'market' | 'limit';

  @IsOptional()
  @IsNumber()
  @Min(0)
  limit_price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  time_in_force?: string;
}
