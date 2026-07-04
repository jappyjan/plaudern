import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { RegisterPushSubscriptionRequest } from '@plaudern/contracts';
import { PushSubscriptionEntity } from '@plaudern/persistence';

/**
 * Owns the per-user web-push subscription rows (one per browser/device). The
 * endpoint is globally unique, so re-subscribing the same device upserts its
 * row and re-points it at the current user.
 */
@Injectable()
export class PushSubscriptionsService {
  constructor(
    @InjectRepository(PushSubscriptionEntity)
    private readonly repo: Repository<PushSubscriptionEntity>,
  ) {}

  /** All active subscriptions for a user — the fan-out targets for web push. */
  list(userId: string): Promise<PushSubscriptionEntity[]> {
    return this.repo.find({ where: { userId }, order: { createdAt: 'ASC' } });
  }

  async count(userId: string): Promise<number> {
    return this.repo.count({ where: { userId } });
  }

  /** Register (or refresh) a subscription, keyed by its unique endpoint. */
  async register(
    userId: string,
    req: RegisterPushSubscriptionRequest,
  ): Promise<PushSubscriptionEntity> {
    const existing = await this.repo.findOne({ where: { endpoint: req.endpoint } });
    if (existing) {
      existing.userId = userId;
      existing.p256dh = req.keys.p256dh;
      existing.auth = req.keys.auth;
      return this.repo.save(existing);
    }
    return this.repo.save(
      this.repo.create({
        userId,
        endpoint: req.endpoint,
        p256dh: req.keys.p256dh,
        auth: req.keys.auth,
      }),
    );
  }

  /** Remove one subscription owned by the user (idempotent). */
  async remove(userId: string, endpoint: string): Promise<void> {
    await this.repo.delete({ userId, endpoint });
  }

  /**
   * Drop a dead subscription by endpoint regardless of owner — used when a push
   * service reports HTTP 404/410 during a fan-out.
   */
  async pruneByEndpoint(endpoint: string): Promise<void> {
    await this.repo.delete({ endpoint });
  }
}
