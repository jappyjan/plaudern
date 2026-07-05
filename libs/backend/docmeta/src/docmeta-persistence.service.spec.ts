import type { Repository } from 'typeorm';
import type { ExtractedDocMeta, ExtractedEntity, ExtractedReminder } from '@plaudern/contracts';
import type { DocumentMetadataEntity } from '@plaudern/persistence';
import type { RemindersPersistenceService } from '@plaudern/reminders';
import type { EntitiesRegistryService } from '@plaudern/entities';
import { DocMetaPersistenceService } from './docmeta-persistence.service';

/**
 * Unit tests for the docmeta persistence wiring (JJ-30/JJ-16): the two
 * cross-cutting behaviors the ticket calls out — expiry/Kündigungsfrist dates
 * becoming reminders, and business cards enriching a contact. The reminders
 * infra and entity registry are faked; we assert docmeta hands them the right
 * shapes. (Date RESOLUTION itself is covered by the reminders infra's own
 * reminder-date spec; here we verify docmeta forwards the dates as reminders.)
 */

const USER = 'user-1';
const ITEM = 'item-1';
const EXTRACTION = 'extraction-1';
const OCCURRED_AT = '2026-01-10T09:00:00.000Z';

function makeDocsRepo(): {
  repo: Repository<DocumentMetadataEntity>;
  saved: Partial<DocumentMetadataEntity>[];
} {
  const saved: Partial<DocumentMetadataEntity>[] = [];
  const repo = {
    findOne: async () => null,
    create: (v: Partial<DocumentMetadataEntity>) => ({ ...v }),
    save: async (v: Partial<DocumentMetadataEntity>) => {
      saved.push(v);
      return v;
    },
  } as unknown as Repository<DocumentMetadataEntity>;
  return { repo, saved };
}

function makeService() {
  const { repo, saved } = makeDocsRepo();
  const reminderCalls: { extracted: ExtractedReminder[] }[] = [];
  const reminders = {
    persist: async (
      _userId: string,
      _itemId: string,
      _extractionId: string,
      _occurredAt: string,
      extracted: ExtractedReminder[],
    ) => {
      reminderCalls.push({ extracted });
      return extracted.length;
    },
  } as unknown as RemindersPersistenceService;

  const ingestCalls: { entities: ExtractedEntity[] }[] = [];
  const registry = {
    ingest: async (
      _userId: string,
      _itemId: string,
      _extractionId: string,
      entities: ExtractedEntity[],
    ) => {
      ingestCalls.push({ entities });
      return entities.length;
    },
  } as unknown as EntitiesRegistryService;

  const service = new DocMetaPersistenceService(repo, reminders, registry);
  return { service, saved, reminderCalls, ingestCalls };
}

const baseDoc: ExtractedDocMeta = {
  documentType: 'other',
  title: 'A document',
  summary: null,
  issuer: null,
  fields: [],
  amount: null,
  currency: null,
  iban: null,
  expiryDate: null,
  cancellationDate: null,
  contact: null,
  confidence: null,
};

describe('DocMetaPersistenceService', () => {
  it('turns expiry + Kündigungsfrist dates into two reminders', async () => {
    const { service, reminderCalls } = makeService();
    const doc: ExtractedDocMeta = {
      ...baseDoc,
      documentType: 'contract',
      title: 'Vodafone mobile contract',
      issuer: 'Vodafone',
      expiryDate: '2027-05-01',
      cancellationDate: '2027-02-01',
    };

    const result = await service.persist(USER, ITEM, EXTRACTION, OCCURRED_AT, doc);

    expect(reminderCalls).toHaveLength(1);
    const titles = reminderCalls[0].extracted.map((r) => r.title);
    expect(titles).toEqual([
      'Contract — Vodafone expires',
      'Cancellation deadline (Kündigungsfrist): Contract — Vodafone',
    ]);
    const dueDates = reminderCalls[0].extracted.map((r) => r.dueDate);
    expect(dueDates).toEqual(['2027-05-01', '2027-02-01']);
    expect(result.reminderCount).toBe(2);
  });

  it('creates no reminders when there are no deadline dates', async () => {
    const { service, reminderCalls } = makeService();
    const result = await service.persist(USER, ITEM, EXTRACTION, OCCURRED_AT, {
      ...baseDoc,
      documentType: 'receipt',
      title: 'Grocery receipt',
    });
    expect(reminderCalls).toHaveLength(0);
    expect(result.reminderCount).toBe(0);
  });

  it('enriches a contact from a business card (person + organization entities)', async () => {
    const { service, ingestCalls } = makeService();
    const doc: ExtractedDocMeta = {
      ...baseDoc,
      documentType: 'business_card',
      title: 'Dr. Erika Mustermann — ACME GmbH',
      contact: {
        fullName: 'Erika Mustermann',
        organization: 'ACME GmbH',
        jobTitle: 'CTO',
        email: 'erika@acme.example',
        phone: '+49 30 123456',
        address: null,
        website: null,
      },
    };

    const result = await service.persist(USER, ITEM, EXTRACTION, OCCURRED_AT, doc);

    expect(ingestCalls).toHaveLength(1);
    const entities = ingestCalls[0].entities;
    expect(entities).toEqual([
      { type: 'person', name: 'Erika Mustermann', mentions: ['Erika Mustermann'] },
      { type: 'organization', name: 'ACME GmbH', mentions: ['ACME GmbH'] },
    ]);
    expect(result.contactEnriched).toBe(true);
  });

  it('does not enrich a contact for non-business-card documents even if contact is present', async () => {
    const { service, ingestCalls } = makeService();
    const result = await service.persist(USER, ITEM, EXTRACTION, OCCURRED_AT, {
      ...baseDoc,
      documentType: 'letter',
      contact: {
        fullName: 'Someone',
        organization: null,
        jobTitle: null,
        email: null,
        phone: null,
        address: null,
        website: null,
      },
    });
    expect(ingestCalls).toHaveLength(0);
    expect(result.contactEnriched).toBe(false);
  });

  it('persists the document row with clamped/normalized fields', async () => {
    const { service, saved } = makeService();
    await service.persist(USER, ITEM, EXTRACTION, OCCURRED_AT, {
      ...baseDoc,
      documentType: 'invoice',
      title: 'Invoice R-2026-0192',
      amount: 129.9,
      currency: 'EUR',
      iban: 'DE89370400440532013000',
      fields: [{ label: 'Invoice no.', value: 'R-2026-0192' }],
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      userId: USER,
      inboxItemId: ITEM,
      extractionId: EXTRACTION,
      documentType: 'invoice',
      amount: 129.9,
      currency: 'EUR',
      iban: 'DE89370400440532013000',
    });
    expect(saved[0].fields).toEqual([{ label: 'Invoice no.', value: 'R-2026-0192' }]);
  });
});
