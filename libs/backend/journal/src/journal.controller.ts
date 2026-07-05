import { BadRequestException, Controller, Get, Param, Post } from '@nestjs/common';
import {
  journalPeriodTypeSchema,
  type JournalDocumentResponse,
  type JournalPeriodListResponse,
  type JournalPeriodType,
  type JournalVersionDetailDto,
  type JournalVersionListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { JournalService } from './journal.service';

/**
 * Auto-journal (JJ-17): daily narrative diary entries and weekly/monthly/yearly
 * reviews composed from them, each fully cited back to its sources. Hangs off
 * /journal — reached from the header, no new bottom-nav tab.
 */
@Controller({ path: 'journal', version: '1' })
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  /** Every composed entry of a granularity, newest first. */
  @Get(':periodType')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('periodType') periodType: string,
  ): Promise<JournalPeriodListResponse> {
    return this.journal.listPeriods(user.id, parsePeriodType(periodType));
  }

  /** One period's current entry (body + latest-attempt status). */
  @Get(':periodType/:periodKey')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('periodType') periodType: string,
    @Param('periodKey') periodKey: string,
  ): Promise<JournalDocumentResponse> {
    return this.journal.getJournal(user.id, parsePeriodType(periodType), periodKey);
  }

  /** A period's succeeded version history (metadata only). */
  @Get(':periodType/:periodKey/versions')
  versions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('periodType') periodType: string,
    @Param('periodKey') periodKey: string,
  ): Promise<JournalVersionListResponse> {
    return this.journal.listVersions(user.id, parsePeriodType(periodType), periodKey);
  }

  /** One historical version rendered in full. */
  @Get(':periodType/:periodKey/versions/:version')
  version(
    @CurrentUser() user: AuthenticatedUser,
    @Param('periodType') periodType: string,
    @Param('periodKey') periodKey: string,
    @Param('version') version: string,
  ): Promise<JournalVersionDetailDto> {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('invalid version');
    }
    return this.journal.getVersion(user.id, parsePeriodType(periodType), periodKey, parsed);
  }

  /** Manually (re)compose the period, then return the refreshed read model. */
  @Post(':periodType/:periodKey/regenerate')
  async regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('periodType') periodType: string,
    @Param('periodKey') periodKey: string,
  ): Promise<JournalDocumentResponse> {
    const type = parsePeriodType(periodType);
    await this.journal.regenerate(user.id, type, periodKey);
    return this.journal.getJournal(user.id, type, periodKey);
  }
}

function parsePeriodType(value: string): JournalPeriodType {
  const parsed = journalPeriodTypeSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('invalid period type');
  return parsed.data;
}
