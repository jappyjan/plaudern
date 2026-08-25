import type { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { assertStrongEncryptionSecret } from '@plaudern/contracts';
import {
  AiProviderEntity,
  CalendarFeedEntity,
  EmailSettingsEntity,
  PlaudSettingsEntity,
} from './entities';
import { decryptSecret, encryptSecret } from './secret-crypto';

type EncryptedTarget = {
  entity: EntityTarget<ObjectLiteral>;
  property: string;
};

const ENCRYPTED_TARGETS: EncryptedTarget[] = [
  { entity: AiProviderEntity, property: 'apiKeyEncrypted' },
  { entity: PlaudSettingsEntity, property: 'passwordEncrypted' },
  { entity: CalendarFeedEntity, property: 'urlEncrypted' },
  { entity: CalendarFeedEntity, property: 'googleRefreshTokenEncrypted' },
  { entity: EmailSettingsEntity, property: 'tokenEncrypted' },
];
const BATCH_SIZE = 100;

export async function rotateEncryptionSecret(
  dataSource: DataSource,
  oldSecret: string,
  newSecret: string,
): Promise<number> {
  if (!oldSecret) throw new Error('APP_ENCRYPTION_SECRET_OLD is required');
  assertStrongEncryptionSecret(newSecret);
  if (oldSecret === newSecret) throw new Error('old and new encryption secrets must differ');

  return dataSource.transaction(async (manager) => {
    let rotated = 0;
    for (const target of ENCRYPTED_TARGETS) {
      const repository = manager.getRepository(target.entity);
      const primaryColumn = repository.metadata.primaryColumns[0];
      if (repository.metadata.primaryColumns.length !== 1 || !primaryColumn) {
        throw new Error(`rotation requires one primary key on ${repository.metadata.tableName}`);
      }
      let afterId: unknown;
      while (true) {
        const query = repository
          .createQueryBuilder('record')
          .orderBy(`record.${primaryColumn.propertyPath}`, 'ASC')
          .take(BATCH_SIZE);
        if (afterId !== undefined) {
          query.where(`record.${primaryColumn.propertyPath} > :afterId`, { afterId });
        }
        const rows = await query.getMany();
        const changedRows: ObjectLiteral[] = [];
        for (const row of rows) {
          const ciphertext = row[target.property];
          if (ciphertext === null || ciphertext === undefined) continue;
          if (typeof ciphertext !== 'string') {
            throw new Error(
              `invalid encrypted value in ${repository.metadata.tableName}.${target.property}`,
            );
          }
          row[target.property] = encryptSecret(decryptSecret(ciphertext, oldSecret), newSecret);
          changedRows.push(row);
          rotated += 1;
        }
        if (changedRows.length > 0) await repository.save(changedRows);
        if (rows.length < BATCH_SIZE) break;
        afterId = rows[rows.length - 1][primaryColumn.propertyName];
      }
    }
    return rotated;
  });
}
