import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { JournalPeriodType } from '@plaudern/contracts';
import {
  CalendarEventEntity,
  InboxItemEntity,
  JournalDocumentEntity,
} from '@plaudern/persistence';
import { JOURNAL_PROVIDER, type JournalProvider } from './journal.provider';
import type { JournalJob } from './journal.job';
import {
  buildItemText,
  itemTitle,
  numberSources,
  sanitizeMarkers,
  toJournalCitation,
  usedMarkers,
  type RawJournalSource,
} from './journal-context';
import { parentKeyOfDay, periodLabel, periodRange } from './journal-period';

/**
 * Executes one journal composition job. For a DAY it gathers that day's signals
 * (non-merged recordings with their summaries/transcripts, plus calendar
 * events) into a numbered, oldest-first source list; for a WEEK/MONTH/YEAR it
 * gathers the daily entries that fall inside it. The sources (plus the current
 * entry, so it UPDATES rather than rewrites) go to the provider, then the new
 * version is persisted. Every source referenced by an in-range `[n]` marker
 * becomes a structural citation; out-of-range markers are stripped so a
 * hallucinated number never renders as a chip. Shared by the inline and BullMQ
 * queues.
 */
@Injectable()
export class JournalProcessor {
  private readonly logger = new Logger(JournalProcessor.name);

  constructor(
    @Inject(JOURNAL_PROVIDER)
    private readonly provider: JournalProvider,
    @InjectRepository(JournalDocumentEntity)
    private readonly documents: Repository<JournalDocumentEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(CalendarEventEntity)
    private readonly events: Repository<CalendarEventEntity>,
  ) {}

  async process(job: JournalJob): Promise<void> {
    const doc = await this.documents.findOne({ where: { id: job.documentId } });
    if (!doc) return; // version row was pruned — nothing to do.

    await this.documents.update({ id: doc.id }, { status: 'processing' });
    try {
      const raw =
        job.periodType === 'day'
          ? await this.collectDaySources(job.userId, job.periodKey)
          : await this.collectRollupSources(job.userId, job.periodType, job.periodKey);
      if (raw.length === 0) {
        throw new Error(
          job.periodType === 'day'
            ? 'no signals with usable content to compose this day'
            : 'no daily entries to compose this period from',
        );
      }
      const sources = numberSources(raw);

      const previous = await this.documents.findOne({
        where: {
          userId: job.userId,
          periodType: job.periodType,
          periodKey: job.periodKey,
          status: 'succeeded',
        },
        order: { version: 'DESC' },
      });

      const result = await this.provider.generate({
        periodType: job.periodType,
        periodKey: job.periodKey,
        periodLabel: periodLabel(job.periodType, job.periodKey),
        sources: sources.map((s) => ({
          marker: s.marker,
          kind: s.kind,
          title: s.title,
          occurredAt: s.occurredAt,
          text: s.text,
        })),
        previousMarkdown: previous?.markdown ?? null,
      });

      const markdown = sanitizeMarkers(result.markdown, sources.length);
      const cited = usedMarkers(markdown, sources.length);
      const citations = sources.filter((s) => cited.has(s.marker)).map(toJournalCitation);

      await this.documents.update(
        { id: doc.id },
        {
          status: 'succeeded',
          markdown,
          citations,
          sourceItemCount: sources.length,
          model: result.model ?? null,
          error: null,
        },
      );
      this.logger.log(
        `composed ${job.periodType} journal ${job.periodKey} v${doc.version} ` +
          `(${sources.length} source(s), ${citations.length} cited)`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `journal composition failed for ${job.periodType} ${job.periodKey}: ${message}`,
      );
      await this.documents.update({ id: doc.id }, { status: 'failed', error: message });
      throw err;
    }
  }

  /** One day's signals: non-merged recordings + calendar events, as raw sources. */
  private async collectDaySources(userId: string, dayKey: string): Promise<RawJournalSource[]> {
    const { startIso, endExclusiveIso } = periodRange('day', dayKey);

    const items = await this.items
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.extractions', 'extractions')
      .where('item.userId = :userId', { userId })
      .andWhere('item.occurredAt >= :start AND item.occurredAt < :end', {
        start: startIso,
        end: endExclusiveIso,
      })
      .andWhere((qb) => {
        const sub = qb
          .subQuery()
          .select('1')
          .from('recording_merges', 'rm')
          .where('rm.sourceItemId = item.id')
          .getQuery();
        return `NOT EXISTS ${sub}`;
      })
      .getMany();

    const raw: RawJournalSource[] = [];
    for (const item of items) {
      const text = buildItemText(item);
      if (!text) continue;
      raw.push({
        kind: 'item',
        refId: item.id,
        title: itemTitle(item),
        occurredAt: iso(item.occurredAt),
        text,
        startSeconds: null,
      });
    }

    const events = await this.events
      .createQueryBuilder('ev')
      .where('ev.userId = :userId', { userId })
      .andWhere('ev.startAt >= :start AND ev.startAt < :end', {
        start: startIso,
        end: endExclusiveIso,
      })
      .getMany();
    for (const ev of events) {
      raw.push({
        kind: 'event',
        refId: ev.id,
        title: ev.title ?? 'Untitled event',
        occurredAt: iso(ev.startAt),
        text: eventText(ev),
        startSeconds: null,
      });
    }

    return raw;
  }

  /** A rollup's sources: the daily entries whose day falls inside the period. */
  private async collectRollupSources(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<RawJournalSource[]> {
    const dailies = await this.documents.find({
      where: { userId, periodType: 'day', status: 'succeeded' },
      order: { periodKey: 'ASC', version: 'DESC' },
    });
    const parent = periodType as Exclude<JournalPeriodType, 'day'>;
    const seen = new Set<string>();
    const raw: RawJournalSource[] = [];
    for (const d of dailies) {
      if (parentKeyOfDay(d.periodKey, parent) !== periodKey) continue;
      if (seen.has(d.periodKey)) continue; // keep only the highest succeeded version
      seen.add(d.periodKey);
      if (!d.markdown) continue;
      raw.push({
        kind: 'journal',
        refId: d.periodKey,
        title: periodLabel('day', d.periodKey),
        occurredAt: `${d.periodKey}T00:00:00.000Z`,
        text: d.markdown,
        startSeconds: null,
      });
    }
    return raw;
  }
}

/** Compact prose for a calendar event: title, time, location, description. */
function eventText(ev: CalendarEventEntity): string {
  const parts: string[] = [];
  parts.push(ev.title ?? 'Untitled event');
  const when = ev.isAllDay
    ? 'All day'
    : `${new Date(ev.startAt).toISOString()} – ${new Date(ev.endAt).toISOString()}`;
  parts.push(when);
  if (ev.location) parts.push(`Location: ${ev.location}`);
  if (ev.description) parts.push(ev.description);
  return parts.join('\n');
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
