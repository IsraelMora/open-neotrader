import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { TotpRequiredGuard } from '../auth/guards/totp-required.guard';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(TotpRequiredGuard)
@Controller('users')
export class UsersController {
  @Get('me')
  @ApiOperation({ summary: 'Perfil del usuario autenticado' })
  me(@Request() req: { user: { id: string; username: string } }) {
    return { id: req.user.id, username: req.user.username };
  }
}
