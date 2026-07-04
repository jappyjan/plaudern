import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_TIMEZONE,
  defaultNotificationCategoryPreferences,
  notificationCategorySchema,
  type NotificationCategory,
  type NotificationCategoryPreference,
  type QuietHours,
  type UpdateNotificationPreferencesRequest,
} from '@plaudern/contracts';
import {
  NotificationCategoryPreferenceEntity,
  NotificationSettingsEntity,
} from '@plaudern/persistence';

/** The resolved, defaults-applied preferences the engine dispatches against. */
export interface ResolvedPreferences {
  timezone: string;
  emailAddress: string | null;
  quietHours: QuietHours;
  /** Effective per-category preference, keyed by category (defaults merged in). */
  categories: Map<NotificationCategory, NotificationCategoryPreference>;
}

/**
 * Owns the per-user notification settings + per-category preference rows.
 * Absent rows fall back to library defaults, so a brand-new user already has a
 * sensible (non-spammy) configuration without any writes.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    @InjectRepository(NotificationSettingsEntity)
    private readonly settingsRepo: Repository<NotificationSettingsEntity>,
    @InjectRepository(NotificationCategoryPreferenceEntity)
    private readonly categoryRepo: Repository<NotificationCategoryPreferenceEntity>,
  ) {}

  /** Full resolved preferences (settings + categories, defaults applied). */
  async resolve(userId: string): Promise<ResolvedPreferences> {
    const [settings, categoryRows] = await Promise.all([
      this.settingsRepo.findOne({ where: { userId } }),
      this.categoryRepo.find({ where: { userId } }),
    ]);

    const categories = new Map<NotificationCategory, NotificationCategoryPreference>();
    for (const pref of defaultNotificationCategoryPreferences()) {
      categories.set(pref.category, pref);
    }
    for (const row of categoryRows) {
      const parsed = notificationCategorySchema.safeParse(row.category);
      if (!parsed.success) continue; // ignore rows for retired categories
      categories.set(parsed.data, {
        category: parsed.data,
        channels: row.channels,
        maxPerDay: row.maxPerDay,
      });
    }

    return {
      timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
      emailAddress: settings?.emailAddress ?? null,
      quietHours: settings
        ? {
            enabled: settings.quietHoursEnabled,
            start: settings.quietHoursStart,
            end: settings.quietHoursEnd,
          }
        : { ...DEFAULT_QUIET_HOURS },
      categories,
    };
  }

  /** Category preferences in stable category order (for the read model). */
  async listCategoryPreferences(userId: string): Promise<NotificationCategoryPreference[]> {
    const resolved = await this.resolve(userId);
    return notificationCategorySchema.options.map(
      (category) => resolved.categories.get(category) as NotificationCategoryPreference,
    );
  }

  /** Persist a partial update: settings fields and/or per-category rows. */
  async update(userId: string, req: UpdateNotificationPreferencesRequest): Promise<void> {
    if (
      req.timezone !== undefined ||
      req.emailAddress !== undefined ||
      req.quietHours !== undefined
    ) {
      const settings =
        (await this.settingsRepo.findOne({ where: { userId } })) ??
        this.settingsRepo.create({
          userId,
          timezone: DEFAULT_TIMEZONE,
          emailAddress: null,
          quietHoursEnabled: DEFAULT_QUIET_HOURS.enabled,
          quietHoursStart: DEFAULT_QUIET_HOURS.start,
          quietHoursEnd: DEFAULT_QUIET_HOURS.end,
        });
      if (req.timezone !== undefined) settings.timezone = req.timezone;
      if (req.emailAddress !== undefined) settings.emailAddress = req.emailAddress;
      if (req.quietHours !== undefined) {
        settings.quietHoursEnabled = req.quietHours.enabled;
        settings.quietHoursStart = req.quietHours.start;
        settings.quietHoursEnd = req.quietHours.end;
      }
      await this.settingsRepo.save(settings);
    }

    if (req.categories !== undefined) {
      for (const pref of req.categories) {
        const existing = await this.categoryRepo.findOne({
          where: { userId, category: pref.category },
        });
        if (existing) {
          existing.channels = pref.channels;
          existing.maxPerDay = pref.maxPerDay;
          await this.categoryRepo.save(existing);
        } else {
          await this.categoryRepo.save(
            this.categoryRepo.create({
              userId,
              category: pref.category,
              channels: pref.channels,
              maxPerDay: pref.maxPerDay,
            }),
          );
        }
      }
    }
  }
}
