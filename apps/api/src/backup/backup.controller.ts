import { Controller, Post, Get, Body } from '@nestjs/common';
import { BackupService } from './backup.service';
import { CreateBackupDto, RestoreBackupDto } from './dto/backup.dto';

@Controller('backup')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get()
  list() {
    return this.backup.listBackups();
  }

  @Post('create')
  async create(@Body() dto: CreateBackupDto) {
    return this.backup.createBackup(dto.passphrase);
  }

  @Post('restore')
  async restore(@Body() dto: RestoreBackupDto) {
    return this.backup.restoreBackup(dto.path, dto.passphrase);
  }
}
