import { Module } from '@nestjs/common';
import { SignatureGuard, SIGNATURE_WINDOW_MS } from './signature.guard';

@Module({
  providers: [
    SignatureGuard,
    { provide: SIGNATURE_WINDOW_MS, useValue: 300_000 },
  ],
  exports: [SignatureGuard],
})
export class AuthModule {}
