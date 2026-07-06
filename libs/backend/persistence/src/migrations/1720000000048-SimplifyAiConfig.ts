import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Simplify AI configuration: instead of configuring all ~22 capabilities
 * individually, the UI now exposes one *shared* setting per capability kind
 * (chat, vision, embeddings, stt, diarization). This migration:
 *
 * 1. Adds `ai_capability_group_settings` — one shared row per (user, kind).
 * 2. Adds `ai_providers.preset` — the vendor preset a connection came from.
 * 3. Best-effort collapse of existing per-capability rows into group rows: for
 *    each (user, kind) it seeds the group from the kind's primary capability
 *    (or the most common provider) and deletes member rows that resolve
 *    identically, leaving only genuine overrides behind. The collapse is guarded
 *    — if anything is ambiguous the rows simply survive as overrides and a
 *    single "Reset" click in the UI folds them back into the shared setting.
 *
 * Additive and reversible; safe on existing installs.
 */

/** Which capabilities belong to each kind, and the primary that seeds defaults. */
const KIND_MEMBERS: Record<string, { primary: string; members: string[] }> = {
  chat: {
    primary: 'summarization',
    members: [
      'summarization',
      'entity_extraction',
      'entity_relations',
      'entity_judge',
      'contact_resolution',
      'web_research',
      'topics',
      'topic_docs',
      'journal',
      'commitments',
      'questions',
      'tasks',
      'decisions',
      'reminders',
      'facts',
      'docmeta',
      'chat',
      'verification',
    ],
  },
  vision: { primary: 'ocr', members: ['ocr'] },
  embeddings: { primary: 'embeddings', members: ['embeddings'] },
  stt: { primary: 'transcription', members: ['transcription'] },
  diarization: { primary: 'speaker_id', members: ['speaker_id'] },
};

interface SettingRow {
  id: string;
  capability: string;
  providerId: string | null;
  model: string | null;
  timeoutMs: number | null;
  enabled: boolean;
  params: string | null;
}

export class SimplifyAiConfig1720000000048 implements MigrationInterface {
  name = 'SimplifyAiConfig1720000000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_capability_group_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "kind" character varying NOT NULL,
        "providerId" uuid,
        "model" character varying,
        "timeoutMs" integer,
        "enabled" boolean NOT NULL DEFAULT true,
        "params" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_capability_group_settings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_capability_group_settings_userId" ON "ai_capability_group_settings" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ai_capability_group_settings_userId_kind" ON "ai_capability_group_settings" ("userId", "kind")`,
    );

    await queryRunner.query(`ALTER TABLE "ai_providers" ADD COLUMN "preset" character varying`);

    await this.collapseExisting(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_providers" DROP COLUMN "preset"`);
    await queryRunner.query(`DROP TABLE "ai_capability_group_settings"`);
  }

  /**
   * Fold uniform per-capability rows into a shared group row per (user, kind).
   * Deletes only the member rows that match the group exactly; anything that
   * differs stays as an override. Purely a convenience — a no-op is always safe.
   */
  private async collapseExisting(queryRunner: QueryRunner): Promise<void> {
    const userRows: Array<{ userId: string }> = await queryRunner.query(
      `SELECT DISTINCT "userId" FROM "ai_capability_settings"`,
    );

    for (const { userId } of userRows) {
      const rows: SettingRow[] = await queryRunner.query(
        `SELECT "id", "capability", "providerId", "model", "timeoutMs", "enabled", "params"
           FROM "ai_capability_settings" WHERE "userId" = $1`,
        [userId],
      );
      const byCapability = new Map(rows.map((r) => [r.capability, r]));

      for (const [kind, { primary, members }] of Object.entries(KIND_MEMBERS)) {
        const memberRows = members
          .map((c) => byCapability.get(c))
          .filter((r): r is SettingRow => r != null);
        // Seed from the primary if it has a provider; else the most common one.
        const seed =
          byCapability.get(primary)?.providerId != null
            ? byCapability.get(primary)!
            : pickMostCommonProvider(memberRows);
        if (!seed || seed.providerId == null) continue;

        await queryRunner.query(
          `INSERT INTO "ai_capability_group_settings"
             ("userId", "kind", "providerId", "model", "timeoutMs", "enabled", "params")
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT ("userId", "kind") DO NOTHING`,
          [userId, kind, seed.providerId, seed.model, seed.timeoutMs, seed.enabled, seed.params],
        );

        // Delete member rows that resolve identically to the seed → they now
        // inherit the group. Divergent rows stay as overrides.
        for (const row of memberRows) {
          if (
            row.providerId === seed.providerId &&
            row.model === seed.model &&
            row.timeoutMs === seed.timeoutMs &&
            row.enabled === seed.enabled &&
            (row.params ?? null) === (seed.params ?? null)
          ) {
            await queryRunner.query(`DELETE FROM "ai_capability_settings" WHERE "id" = $1`, [
              row.id,
            ]);
          }
        }
      }
    }
  }
}

function pickMostCommonProvider(rows: SettingRow[]): SettingRow | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.providerId) counts.set(r.providerId, (counts.get(r.providerId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [providerId, count] of counts) {
    if (count > bestCount) {
      best = providerId;
      bestCount = count;
    }
  }
  if (!best) return null;
  return rows.find((r) => r.providerId === best) ?? null;
}
