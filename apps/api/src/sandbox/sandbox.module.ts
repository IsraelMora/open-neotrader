import { Module } from '@nestjs/common';
import { SandboxGateway } from './sandbox.gateway';

@Module({
  providers: [SandboxGateway],
  exports: [SandboxGateway],
})
export class SandboxModule {}
