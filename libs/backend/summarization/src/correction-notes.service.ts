import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InboxService } from '@plaudern/inbox';
import type {
  CorrectionNoteDto,
  CorrectionNoteMutationResponse,
  ExtractionStatus,
} from '@plaudern/contracts';
import { CorrectionNoteEntity, type InboxItemEntity } from '@plaudern/persistence';
import { SummarizationService } from './summarization.service';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * User correction notes on an inbox item ("the name is 'Meier', not 'Maier'"):
 * stored outside the append-only inbox aggregate, injected into every future
 * summary generation via SummaryContextService, and — so the correction shows
 * up without a manual retry — every add/delete best-effort enqueues a fresh
 * summary row. The regeneration is append-only and cascades through the
 * extraction DAG to whatever depends on the summary; the source blob and its
 * transcription/OCR rows are never touched.
 *
 * Lives in this module (not @plaudern/inbox) for the same reason as the
 * summary routes: the inbox lib must stay free of summarization dependencies.
 */
@Injectable()
export class CorrectionNotesService {
  private readonly logger = new Logger(CorrectionNotesService.name);

  constructor(
    @InjectRepository(CorrectionNoteEntity)
    private readonly notes: Repository<CorrectionNoteEntity>,
    private readonly inbox: InboxService,
    private readonly summarization: SummarizationService,
  ) {}

  async list(userId: string, inboxItemId: string): Promise<CorrectionNoteDto[]> {
    // Ownership gate — throws NotFound for foreign/unknown items.
    await this.inbox.getItem(userId, inboxItemId);
    return this.listDtos(inboxItemId);
  }

  async add(
    userId: string,
    inboxItemId: string,
    body: string,
  ): Promise<CorrectionNoteMutationResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    await this.notes.save(this.notes.create({ userId, inboxItemId, body }));
    const summaryQueued = await this.maybeRegenerateSummary(item);
    return { notes: await this.listDtos(inboxItemId), summaryQueued };
  }

  async remove(
    userId: string,
    inboxItemId: string,
    noteId: string,
  ): Promise<CorrectionNoteMutationResponse> {
    const item = await this.inbox.getItem(userId, inboxItemId);
    const note = await this.notes.findOne({
      where: { id: noteId, inboxItemId, userId },
    });
    if (!note) throw new NotFoundException('correction note not found');
    await this.notes.remove(note);
    // A removed note must also stop influencing the summary, so regenerate
    // here too — a retracted correction is as real a change as a new one.
    const summaryQueued = await this.maybeRegenerateSummary(item);
    return { notes: await this.listDtos(inboxItemId), summaryQueued };
  }

  private async listDtos(inboxItemId: string): Promise<CorrectionNoteDto[]> {
    const rows = await this.notes.find({
      where: { inboxItemId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    }));
  }

  /**
   * Best-effort summary regeneration, mirroring the guards of
   * `SummarizationService.regenerateForItems`: skip when summarization is
   * disabled, when there is nothing to summarize yet, or when a summary is
   * already in flight (that run rebuilds its context when it executes, and
   * notes apply to whichever generation runs next). Never throws — a failed
   * enqueue must not lose the saved note.
   */
  private async maybeRegenerateSummary(item: InboxItemEntity): Promise<boolean> {
    try {
      if (!(await this.summarization.isEnabled(item.userId))) return false;
      const extractions = item.extractions ?? [];
      const transcription = latestOfKind(extractions, 'transcription');
      if (transcription?.status !== 'succeeded') return false;
      const summary = latestOfKind(extractions, 'summary');
      if (summary && ACTIVE_STATUSES.includes(summary.status)) return false;
      await this.summarization.enqueueSummary(item.id);
      return true;
    } catch (err) {
      this.logger.warn(
        `summary regeneration after note change failed for ${item.id}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}

function latestOfKind(
  extractions: NonNullable<InboxItemEntity['extractions']>,
  kind: NonNullable<InboxItemEntity['extractions']>[number]['kind'],
) {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
