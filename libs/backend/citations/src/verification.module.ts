import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '@plaudern/audit';
import { CITATION_VERIFIER } from './verification.provider';
import { OpenAiCitationVerifier } from './providers/openai.verifier';
import { VerificationService } from './verification.service';

/**
 * Verification pass (JJ-20): an LLM-judge that re-checks the high-stakes fields
 * of a generated answer against its cited source passages. A new LLM kind, so
 * it ships DISABLED until VERIFICATION_API_KEY (falling back to the
 * summarization key) is set; consumers call {@link VerificationService.enabled}
 * before invoking and degrade to the dependency-free coverage check when off.
 *
 * The pure coverage utilities ({@link analyzeCitationCoverage}) need no DI and
 * are imported directly from `@plaudern/citations` — only the LLM verifier is
 * wired here.
 */
@Module({
  imports: [ConfigModule, AuditModule],
  providers: [
    OpenAiCitationVerifier,
    {
      provide: CITATION_VERIFIER,
      inject: [OpenAiCitationVerifier],
      useFactory: (openai: OpenAiCitationVerifier) => openai,
    },
    VerificationService,
  ],
  exports: [VerificationService],
})
export class VerificationModule {}
