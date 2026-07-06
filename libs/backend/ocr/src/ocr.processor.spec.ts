import type { InboxService } from '@plaudern/inbox';
import type { StorageService } from '@plaudern/storage';
import type { TranscriptionService } from '@plaudern/transcription';
import { OcrProcessor } from './ocr.processor';
import type { OcrProvider } from './ocr.provider';
import type { OcrJob } from './ocr.job';

const JOB: OcrJob = {
  extractionId: 'ext-1',
  inboxItemId: 'item-1',
  storageKey: 'blobs/doc.png',
  contentType: 'image/png',
  filename: 'doc.png',
};

/** Storage stand-in that streams a fixed buffer for the document blob. */
function fakeStorage(): StorageService {
  return {
    async getObjectStream() {
      const bytes = Buffer.from('fake image bytes');
      return (async function* () {
        yield bytes;
      })();
    },
  } as unknown as StorageService;
}

function fakeInbox(): {
  service: InboxService;
  completed: Array<{ id: string; result: { status: string; content?: string } }>;
} {
  const completed: Array<{ id: string; result: { status: string; content?: string } }> = [];
  const service = {
    async setExtractionStatus() {
      /* no-op */
    },
    // The processor loads the item to attribute the per-user AI call (OcrJob
    // carries no userId).
    async getItemById(id: string) {
      return { id, userId: 'user-1' };
    },
    async completeExtraction(id: string, result: { status: string; content?: string }) {
      completed.push({ id, result });
    },
  } as unknown as InboxService;
  return { service, completed };
}

function fakeProvider(result: { text: string; language?: string }): OcrProvider {
  return {
    id: 'test:ocr',
    recognize: async () => result,
  };
}

describe('OcrProcessor', () => {
  it('bridges recognized text into a passthrough transcription so the DAG cascades', async () => {
    const { service: inbox } = fakeInbox();
    const record = jest.fn(async () => 'transcription-1');
    const transcription = { recordExtractedText: record } as unknown as TranscriptionService;

    const processor = new OcrProcessor(
      inbox,
      fakeStorage(),
      transcription,
      fakeProvider({ text: 'Patient: Jan Jaap\nDiagnose: Rückenschmerzen', language: 'de' }),
    );

    await processor.process(JOB);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('item-1', {
      content: 'Patient: Jan Jaap\nDiagnose: Rückenschmerzen',
      language: 'de',
    });
  });

  it('does not spawn a transcription for a blank scan (empty recognized text)', async () => {
    const { service: inbox } = fakeInbox();
    const record = jest.fn(async () => 'transcription-1');
    const transcription = { recordExtractedText: record } as unknown as TranscriptionService;

    const processor = new OcrProcessor(
      inbox,
      fakeStorage(),
      transcription,
      fakeProvider({ text: '   \n  ' }),
    );

    await processor.process(JOB);

    expect(record).not.toHaveBeenCalled();
  });
});
