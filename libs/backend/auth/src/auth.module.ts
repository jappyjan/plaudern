import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PersistenceModule } from '@plaudern/persistence';
import { AuthController } from './auth.controller';
import { SessionAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { ChallengeStore } from './challenge-store';
import { SessionService } from './session.service';

/**
 * Passkey-only multi-user authentication. Importing this module installs the
 * session guard GLOBALLY — every route in the app requires a session unless
 * explicitly marked @Public().
 */
@Module({
  imports: [PersistenceModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    ChallengeStore,
    { provide: APP_GUARD, useClass: SessionAuthGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
