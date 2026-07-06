import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type {
  CommitmentDirection,
  NudgeActionRequest,
  NudgeDto,
  NudgeListResponse,
  NudgeReason,
} from '@plaudern/contracts';
import { InboxService, SelfProfileService } from '@plaudern/inbox';
import { NotificationsService } from '@plaudern/notifications';
import {
  CommitmentEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  NudgeStateEntity,
} from '@plaudern/persistence';
import {
  classifyNudge,
  draftNudgeText,
  isResolvedByLaterItems,
  type LaterItemText,
} from './nudges.resolution';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A commitment that currently warrants a nudge, before user-state filtering. */
interface EligibleNudge {
  commitment: CommitmentEntity;
  occurredAt: string;
  reason: NudgeReason;
}

/**
 * Owns commitment nudges (JJ-26). Nudges are DERIVED, not stored: `evaluate`
 * recomputes the eligible set on demand from the user's open commitments, their
 * due/age (`classifyNudge`), and a deterministic follow-up check against later
 * recordings (`isResolvedByLaterItems`) — only UNRESOLVED commitments surface.
 *
 * The only persisted piece is per-commitment `nudge_state`: the system-owned
 * `nudgedAt` (so a proactive notification fires once) and the user-owned
 * `dismissed`/`snoozedUntil`. Firing is driven by the scheduler; this service
 * exposes the read model, the user actions, and the per-user sweep. Resolution
 * detection is fully deterministic, so nudges add NO external-LLM call site.
 */
@Injectable()
export class NudgesService {
  private readonly logger = new Logger(NudgesService.name);

  constructor(
    @InjectRepository(CommitmentEntity)
    private readonly commitments: Repository<CommitmentEntity>,
    @InjectRepository(NudgeStateEntity)
    private readonly states: Repository<NudgeStateEntity>,
    private readonly inbox: InboxService,
    private readonly selfProfile: SelfProfileService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The user's active nudges for the ledger surface, honoring dismiss/snooze. */
  async listNudges(userId: string, now = new Date()): Promise<NudgeListResponse> {
    if (!(await this.selfProfile.hasOwner(userId))) {
      return { nudges: [], needsOwner: true };
    }
    const eligible = await this.evaluate(userId, now.getTime());
    if (eligible.length === 0) return { nudges: [], needsOwner: false };

    const stateById = await this.statesByCommitment(userId, eligible.map((e) => e.commitment.id));
    const nudges: NudgeDto[] = [];
    for (const e of eligible) {
      const state = stateById.get(e.commitment.id);
      if (state?.dismissed) continue;
      if (state?.snoozedUntil && Date.parse(state.snoozedUntil) > now.getTime()) continue;
      nudges.push(toNudgeDto(e, state ?? null));
    }
    return { nudges, needsOwner: false };
  }

  /**
   * Apply a user action to a nudge. Writes ONLY the user-owned fields; the row
   * is created on first touch. Snooze re-arms the notification by clearing the
   * system-owned `nudgedAt`.
   */
  async act(userId: string, commitmentId: string, req: NudgeActionRequest, now = new Date()): Promise<void> {
    const commitment = await this.commitments.findOne({ where: { id: commitmentId, userId } });
    if (!commitment) throw new NotFoundException('commitment not found');

    const state = await this.findOrCreateState(userId, commitmentId);
    if (req.action === 'dismiss') {
      state.dismissed = true;
    } else {
      const days = req.snoozeDays ?? 3;
      state.snoozedUntil = new Date(now.getTime() + days * DAY_MS).toISOString();
      // Re-arm the proactive notification for when the snooze elapses.
      state.nudgedAt = null;
    }
    await this.states.save(state);
  }

  /** User ids that currently have at least one open, non-duplicate commitment. */
  async userIdsWithOpenCommitments(): Promise<string[]> {
    const rows: Array<{ userId: string }> = await this.commitments
      .createQueryBuilder('c')
      .select('DISTINCT c.userId', 'userId')
      .where('c.status = :status', { status: 'open' })
      .andWhere('c.duplicatesTaskId IS NULL')
      .getRawMany();
    return rows.map((r) => r.userId);
  }

  /**
   * Fire proactive notifications for a user's newly-eligible nudges. Idempotent:
   * a nudge whose `nudgedAt` is already set is skipped (fires ONCE); a nudge the
   * user dismissed or is snoozing is skipped. Suppressed/capped deliveries are
   * NOT marked, so they retry next sweep; anything else is marked so it never
   * re-fires. Returns how many notifications were dispatched.
   */
  async sweepUser(userId: string, now = new Date()): Promise<number> {
    const eligible = await this.evaluate(userId, now.getTime());
    if (eligible.length === 0) return 0;
    const stateById = await this.statesByCommitment(userId, eligible.map((e) => e.commitment.id));

    let fired = 0;
    for (const e of eligible) {
      const state = stateById.get(e.commitment.id) ?? null;
      if (state?.dismissed) continue;
      if (state?.snoozedUntil && Date.parse(state.snoozedUntil) > now.getTime()) continue;
      if (state?.nudgedAt) continue; // already fired — fire once.

      const message = buildNotification(e);
      const result = await this.notifications.notify(userId, { category: 'commitment_nudge', ...message }, now);
      // A quiet-hours / frequency-cap suppression is transient — leave the nudge
      // un-marked so the next sweep retries it. Everything else is terminal.
      if (result.outcome === 'suppressed_quiet_hours' || result.outcome === 'frequency_capped') {
        continue;
      }
      const row = await this.findOrCreateState(userId, e.commitment.id);
      row.nudgedAt = now.toISOString(); // system-owned; never touches user fields.
      await this.states.save(row);
      if (result.outcome === 'sent') fired += 1;
    }
    return fired;
  }

  // ---- Derivation ----

  /**
   * Recompute the eligible nudge set for a user: open, non-duplicate commitments
   * whose timing warrants a nudge AND that no later recording shows resolved.
   */
  private async evaluate(userId: string, now: number): Promise<EligibleNudge[]> {
    const commitments = await this.commitments.find({
      where: { userId, status: 'open', duplicatesTaskId: IsNull() },
    });
    if (commitments.length === 0) return [];

    const { occurredAtById, laterTexts } = await this.itemContext(userId);
    const eligible: EligibleNudge[] = [];
    for (const commitment of commitments) {
      const occurredAt = occurredAtById.get(commitment.inboxItemId);
      if (!occurredAt) continue;
      const classified = classifyNudge({ dueDate: commitment.dueDate, occurredAt, now });
      if (!classified.eligible) continue;
      const resolved = isResolvedByLaterItems({
        description: commitment.description,
        counterpartyName: commitment.counterpartyName || null,
        occurredAt,
        laterTexts,
      });
      if (resolved) continue;
      eligible.push({ commitment, occurredAt, reason: classified.reason });
    }
    return eligible;
  }

  /** occurredAt per item + the lowercased text of every item, for resolution. */
  private async itemContext(
    userId: string,
  ): Promise<{ occurredAtById: Map<string, string>; laterTexts: LaterItemText[] }> {
    const occurredAtById = new Map<string, string>();
    const laterTexts: LaterItemText[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { items, nextCursor } = await this.inbox.listItems(userId, 200, cursor);
      for (const item of items) {
        const occurredAt = iso(item.occurredAt);
        if (!occurredAt) continue;
        occurredAtById.set(item.id, occurredAt);
        const text = itemText(item);
        if (text) laterTexts.push({ occurredAt, text });
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return { occurredAtById, laterTexts };
  }

  private async statesByCommitment(
    userId: string,
    commitmentIds: string[],
  ): Promise<Map<string, NudgeStateEntity>> {
    const map = new Map<string, NudgeStateEntity>();
    if (commitmentIds.length === 0) return map;
    const rows = await this.states.find({
      where: { userId, commitmentId: In(commitmentIds) },
    });
    for (const row of rows) map.set(row.commitmentId, row);
    return map;
  }

  /** Find the nudge_state row or create a fresh (all-defaults) one, race-safe. */
  private async findOrCreateState(userId: string, commitmentId: string): Promise<NudgeStateEntity> {
    const existing = await this.states.findOne({ where: { userId, commitmentId } });
    if (existing) return existing;
    try {
      return await this.states.save(
        this.states.create({ userId, commitmentId, dismissed: false, nudgedAt: null, snoozedUntil: null }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.states.findOne({ where: { userId, commitmentId } });
      if (!winner) throw err;
      return winner;
    }
  }
}

/** Build the notification title/body for one eligible nudge. */
function buildNotification(e: EligibleNudge): { title: string; body: string; url: string; data: Record<string, unknown> } {
  const cp = e.commitment.counterpartyName?.trim() || null;
  const desc = e.commitment.description.trim().replace(/[.!?]+$/, '');
  const due = e.commitment.dueDate ? ` (due ${formatDate(e.commitment.dueDate)})` : '';
  let title: string;
  let body: string;
  if (e.commitment.direction === 'owed_by_me') {
    title = 'A promise you made';
    body = cp
      ? `You told ${cp} you'd ${desc}${due}. No later note shows it's done.`
      : `You said you'd ${desc}${due}. No later note shows it's done.`;
  } else {
    title = 'Someone owes you';
    body = cp
      ? `${cp} owed you: ${desc}${due}. Want to chase it up?`
      : `You're still owed: ${desc}${due}. Want to chase it up?`;
  }
  return { title, body, url: '/open-loops', data: { commitmentId: e.commitment.id, inboxItemId: e.commitment.inboxItemId, reason: e.reason } };
}

function toNudgeDto(e: EligibleNudge, state: NudgeStateEntity | null): NudgeDto {
  return {
    commitmentId: e.commitment.id,
    inboxItemId: e.commitment.inboxItemId,
    direction: e.commitment.direction,
    counterpartyName: e.commitment.counterpartyName || null,
    description: e.commitment.description,
    dueDate: e.commitment.dueDate,
    occurredAt: e.occurredAt,
    reason: e.reason,
    draftText: draftNudgeText(e.commitment.direction as CommitmentDirection, e.commitment.counterpartyName || null, e.commitment.description),
    snoozedUntil: state?.snoozedUntil ?? null,
    notified: Boolean(state?.nudgedAt),
  };
}

/** Lowercased transcription + summary text of an item, for resolution matching. */
function itemText(item: InboxItemEntity): string {
  const extractions = item.extractions ?? [];
  const parts: string[] = [];
  const transcription = latestSucceeded(extractions, 'transcription');
  if (transcription?.content) parts.push(transcription.content);
  const summary = latestSucceeded(extractions, 'summary');
  const summaryText = summaryPlainText(summary?.content);
  if (summaryText) parts.push(summaryText);
  return parts.join(' \n ').toLowerCase();
}

/** Pull the human-readable text out of a summary extraction's JSON payload. */
function summaryPlainText(content: string | null | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const bits = [parsed.title, parsed.markdown].filter((v): v is string => typeof v === 'string');
    return bits.join(' ');
  } catch {
    return '';
  }
}

function latestSucceeded(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind && e.status === 'succeeded')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function formatDate(isoStr: string): string {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Whether a save failed on a unique index, across the drivers we run on:
 * Postgres surfaces SQLSTATE 23505, better-sqlite3 a SQLITE_CONSTRAINT* code /
 * "UNIQUE constraint failed" message. Anything else must propagate.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const driverError = (err as { driverError?: unknown }).driverError ?? err;
  if (!driverError || typeof driverError !== 'object') return false;
  const code = (driverError as { code?: unknown }).code;
  if (code === '23505') return true;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (driverError as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}
