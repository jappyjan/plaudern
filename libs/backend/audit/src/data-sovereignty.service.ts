import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  AccountExport,
  AccountExportItem,
  DeadMansSwitchDto,
  PanicDeleteResponse,
  UpdateDeadMansSwitchRequest,
} from '@plaudern/contracts';
import { InboxService } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import {
  AiProviderCallEntity,
  CalendarEventEntity,
  CalendarFeedEntity,
  ChatConversationEntity,
  ChatMessageEntity,
  ConsentSettingsEntity,
  DeadMansSwitchEntity,
  DeadMansSwitchReleaseEntity,
  DocumentMetadataEntity,
  EmailSettingsEntity,
  EntityAliasEntity,
  EntityMergeSuggestionEntity,
  EntitySuppressionEntity,
  ExtractionRunEntity,
  ItemSensitivityEntity,
  ItemTopicEntity,
  JournalDocumentEntity,
  McpTokenEntity,
  NotificationCategoryPreferenceEntity,
  NotificationDeliveryEntity,
  NotificationSettingsEntity,
  NudgeStateEntity,
  PlaudSettingsEntity,
  PushSubscriptionEntity,
  ReminderEntity,
  SummarizationSettingsEntity,
  TopicDocumentEntity,
  TopicEntity,
  TopicProposalEntity,
  type InboxItemEntity,
} from '@plaudern/persistence';

/**
 * Data-sovereignty controls (JJ-42): export-everything, panic-delete, and the
 * dead-man's-switch scaffold. Every operation is strictly scoped to the passed
 * `userId` (always the authenticated user's id at the controller) — there is no
 * code path that reaches another user's data.
 */
@Injectable()
export class DataSovereigntyService {
  private readonly logger = new Logger(DataSovereigntyService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Assemble the user's whole archive into one self-describing JSON document
   * (items + extractions + presigned asset URLs) plus a combined Markdown
   * rendering. Zero external deps: no zip, no temp files — the document IS the
   * bundle, and assets are referenced by time-limited presigned URLs.
   */
  async exportEverything(userId: string): Promise<AccountExport> {
    const items = await this.loadAllItems(userId);
    const exportItems: AccountExportItem[] = [];

    for (const item of items) {
      const source = item.source;
      exportItems.push({
        id: item.id,
        sourceType: item.sourceType,
        occurredAt: item.occurredAt,
        ingestedAt: new Date(item.ingestedAt).toISOString(),
        metadata: item.metadata,
        source: source
          ? {
              contentType: source.contentType,
              byteSize: source.byteSize,
              originalFilename: source.originalFilename,
              downloadUrl: source.storageKey
                ? await this.presign(source.storageKey)
                : null,
            }
          : null,
        extractions: (item.extractions ?? [])
          .slice()
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            version: e.version,
            provider: e.provider,
            status: e.status,
            content: e.content,
            language: e.language,
            createdAt: new Date(e.createdAt).toISOString(),
            completedAt: e.completedAt ? new Date(e.completedAt).toISOString() : null,
          })),
      });
    }

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      userId,
      itemCount: exportItems.length,
      items: exportItems,
      markdown: renderMarkdown(userId, exportItems),
    };
  }

  /**
   * Irreversibly wipe the user's archive. Reuses the battle-tested
   * `purgeAllForUser` cascade (items, source/derived payloads, diarization
   * occurrences, voice profiles, entity registry, tasks, facts, tombstones,
   * blobs) and then clears the remaining user-scoped standalone tables that
   * cascade misses — mirroring how the merge/purge paths delete children before
   * parents so the wipe is total and referential-integrity-safe on both
   * Postgres and sqlite.
   *
   * The account itself (user row, passkeys, sessions) is intentionally kept so
   * the caller stays authenticated and lands on an empty archive; deleting the
   * login is out of scope for panic-delete.
   */
  async panicDelete(userId: string): Promise<PanicDeleteResponse> {
    const { deletedItems } = await this.inbox.purgeAllForUser(userId);

    let deletedAuditEntries = 0;
    await this.dataSource.transaction(async (em) => {
      // Children before parents so Postgres FKs never block the delete.
      await em.getRepository(ChatMessageEntity).delete({ userId });
      await em.getRepository(ChatConversationEntity).delete({ userId });
      await em.getRepository(CalendarEventEntity).delete({ userId });
      await em.getRepository(CalendarFeedEntity).delete({ userId });
      await em.getRepository(NotificationDeliveryEntity).delete({ userId });
      await em.getRepository(NotificationCategoryPreferenceEntity).delete({ userId });
      await em.getRepository(PushSubscriptionEntity).delete({ userId });
      await em.getRepository(NotificationSettingsEntity).delete({ userId });
      await em.getRepository(ItemTopicEntity).delete({ userId });
      await em.getRepository(TopicDocumentEntity).delete({ userId });
      await em.getRepository(TopicProposalEntity).delete({ userId });
      await em.getRepository(TopicEntity).delete({ userId });
      await em.getRepository(ReminderEntity).delete({ userId });
      // Commitment-nudge state (JJ-26): a user-scoped table holding the user's
      // dismiss/snooze decisions. FK-cascades with commitments on Postgres but
      // lingers on sqlite (purge avoids cascades), so wipe it explicitly.
      await em.getRepository(NudgeStateEntity).delete({ userId });
      await em.getRepository(JournalDocumentEntity).delete({ userId });
      // Entity-graph residue that purge's registry delete leaves behind: aliases
      // and suppressions hold the normalized NAMES of the user's people/places,
      // and extraction runs hold run history + error text. All user-scoped, and
      // the alias FK cascade is unreliable (sqlite FKs off; purge avoids
      // cascades), so delete them explicitly — the wipe must leave no name.
      await em.getRepository(EntityAliasEntity).delete({ userId });
      await em.getRepository(EntityMergeSuggestionEntity).delete({ userId });
      await em.getRepository(EntitySuppressionEntity).delete({ userId });
      await em.getRepository(ExtractionRunEntity).delete({ userId });
      // Per-item derived tables that cascade with inbox_items on Postgres but
      // linger on sqlite (purge avoids relying on cascades); wipe explicitly.
      await em.getRepository(DocumentMetadataEntity).delete({ userId });
      await em.getRepository(ItemSensitivityEntity).delete({ userId });
      await em.getRepository(McpTokenEntity).delete({ userId });
      await em.getRepository(PlaudSettingsEntity).delete({ userId });
      await em.getRepository(EmailSettingsEntity).delete({ userId });
      await em.getRepository(SummarizationSettingsEntity).delete({ userId });
      await em.getRepository(ConsentSettingsEntity).delete({ userId });
      // Dead-man's-switch intent (JJ-42) AND every release/grant it fired (JJ-80):
      // release rows hold the trusted contact's email + a live access grant, so a
      // panic-delete must wipe them too or a wiped archive could still be reached.
      await em.getRepository(DeadMansSwitchReleaseEntity).delete({ userId });
      await em.getRepository(DeadMansSwitchEntity).delete({ userId });
      const audit = await em.getRepository(AiProviderCallEntity).delete({ userId });
      deletedAuditEntries = audit.affected ?? 0;
    });

    this.logger.warn(
      `panic-delete wiped user ${userId}: ${deletedItems} item(s), ${deletedAuditEntries} audit row(s)`,
    );
    return { deletedItems, deletedAuditEntries };
  }

  async getDeadMansSwitch(userId: string): Promise<DeadMansSwitchDto> {
    const row = await this.dataSource
      .getRepository(DeadMansSwitchEntity)
      .findOne({ where: { userId } });
    return toDeadMansSwitchDto(row);
  }

  async updateDeadMansSwitch(
    userId: string,
    req: UpdateDeadMansSwitchRequest,
  ): Promise<DeadMansSwitchDto> {
    const repo = this.dataSource.getRepository(DeadMansSwitchEntity);
    let row = await repo.findOne({ where: { userId } });
    if (!row) {
      row = repo.create({ userId, lastCheckInAt: null });
    }
    row.enabled = req.enabled;
    row.contactEmail = req.contactEmail;
    row.checkInIntervalDays = req.checkInIntervalDays;
    return toDeadMansSwitchDto(await repo.save(row));
  }

  /**
   * Record that the owner is present, resetting the switch's countdown. F1
   * (JJ-80 review): this is also the ONLY thing that lifts a revoke's
   * arm-suppression (`armingSuspendedForCheckInAt`) — a genuine check-in
   * moves `lastCheckInAt` forward and clears the marker, so a later lapse
   * arms normally again.
   */
  async checkInDeadMansSwitch(userId: string): Promise<DeadMansSwitchDto> {
    const repo = this.dataSource.getRepository(DeadMansSwitchEntity);
    let row = await repo.findOne({ where: { userId } });
    if (!row) row = repo.create({ userId });
    row.lastCheckInAt = new Date().toISOString();
    row.armingSuspendedForCheckInAt = null;
    return toDeadMansSwitchDto(await repo.save(row));
  }

  /** Page through every (non-merged) item for the user with its relations. */
  private async loadAllItems(userId: string): Promise<InboxItemEntity[]> {
    const all: InboxItemEntity[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { items, nextCursor } = await this.inbox.listItems(userId, 200, cursor);
      all.push(...items);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return all;
  }

  private async presign(storageKey: string): Promise<string | null> {
    try {
      return await this.storage.createPresignedGetUrl(storageKey);
    } catch (err) {
      this.logger.warn(`could not presign ${storageKey}: ${(err as Error).message}`);
      return null;
    }
  }
}

function toDeadMansSwitchDto(row: DeadMansSwitchEntity | null): DeadMansSwitchDto {
  if (!row) {
    return {
      configured: false,
      enabled: false,
      contactEmail: null,
      checkInIntervalDays: 90,
      lastCheckInAt: null,
      triggersAt: null,
    };
  }
  const lastCheckInAt = row.lastCheckInAt ? new Date(row.lastCheckInAt) : null;
  const triggersAt = lastCheckInAt
    ? new Date(lastCheckInAt.getTime() + row.checkInIntervalDays * 86_400_000)
    : null;
  return {
    configured: true,
    enabled: row.enabled,
    contactEmail: row.contactEmail,
    checkInIntervalDays: row.checkInIntervalDays,
    lastCheckInAt: lastCheckInAt ? lastCheckInAt.toISOString() : null,
    triggersAt: triggersAt ? triggersAt.toISOString() : null,
  } satisfies DeadMansSwitchDto;
}

/** Best-effort human-readable rendering of the whole archive as one document. */
function renderMarkdown(userId: string, items: AccountExportItem[]): string {
  const lines: string[] = [
    '# Plaudern export',
    '',
    `Exported ${new Date().toISOString()} for user ${userId}.`,
    `${items.length} item(s).`,
    '',
  ];
  for (const item of items) {
    const summary = item.extractions.find((e) => e.kind === 'summary' && e.status === 'succeeded');
    const title = extractSummaryTitle(summary?.content) ?? `${item.sourceType} — ${item.occurredAt}`;
    lines.push(`## ${title}`, '', `- Recorded: ${item.occurredAt}`, `- Type: ${item.sourceType}`, '');

    const summaryMarkdown = extractSummaryMarkdown(summary?.content);
    if (summaryMarkdown) lines.push('### Summary', '', summaryMarkdown, '');

    const transcript = item.extractions.find(
      (e) => e.kind === 'transcription' && e.status === 'succeeded' && e.content,
    );
    if (transcript?.content) {
      lines.push('### Transcript', '', '```', transcript.content, '```', '');
    }
  }
  return lines.join('\n');
}

function parseSummary(content: string | null | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractSummaryTitle(content: string | null | undefined): string | null {
  const parsed = parseSummary(content);
  return parsed && typeof parsed.title === 'string' ? parsed.title : null;
}

function extractSummaryMarkdown(content: string | null | undefined): string | null {
  const parsed = parseSummary(content);
  return parsed && typeof parsed.markdown === 'string' ? parsed.markdown : null;
}
