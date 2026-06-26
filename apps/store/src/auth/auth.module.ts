import { Module } from '@nestjs/common';
import {
  SignatureGuard,
  SIGNATURE_WINDOW_MS,
  DEFAULT_WINDOW_MS,
} from './signature.guard';

@Module({
  providers: [
    SignatureGuard,
    { provide: SIGNATURE_WINDOW_MS, useValue: DEFAULT_WINDOW_MS },
  ],
  exports: [SignatureGuard],
})
export class AuthModule {}
