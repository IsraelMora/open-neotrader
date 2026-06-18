import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

@Module({
  controllers: [UsersController],
  providers: [UsersService, TotpRequiredGuard],
  exports: [UsersService],
})
export class UsersModule {}
