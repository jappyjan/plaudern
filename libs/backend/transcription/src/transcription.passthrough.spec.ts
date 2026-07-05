import { Readable } from 'node:stream';
import type { InboxService } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import type { StorageService } from '@plaudern/storage';
import type { TranscriptionProvider } from './transcription.provider';
import { TEXT_PASSTHROUGH_PROVIDER_ID } from '@plaudern/contracts';
import type { TranscriptionJob, TranscriptionQueue } from './transcription.job';
import { TranscriptionExtractor } from './transcription.extractor';
import { TranscriptionProcessor } from './transcription.processor';
import { TranscriptionService } from './transcription.service';

function fakeItem(overrides: {
  sourceType: string;
  contentType?: string;
  uploadStatus?: string;
}): InboxItemEntity {
  return {
    id: 'item-1',
    sourceType: overrides.sourceType,
    source:
      overrides.contentType === undefined
        ? null
        : {
            storageKey: 'key-1',
            contentType: overrides.contentType,
            uploadStatus: overrides.uploadStatus ?? 'committed',
            originalFilename: null,
          },
  } as unknown as InboxItemEntity;
}

describe('TranscriptionExtractor.appliesTo', () => {
  const extractor = new TranscriptionExtractor(
    undefined as unknown as TranscriptionService,
  );

  it.each([
    ['committed audio source', 'audio', 'audio/mpeg', 'committed', true],
    ['committed text note', 'text', 'text/plain', 'committed', true],
    ['pending text note', 'text', 'text/plain', 'pending', false],
    ['pending audio source', 'audio', 'audio/mpeg', 'pending', false],
    // Every text-bearing source's text payload is processed by default.
    ['text/plain file upload', 'file', 'text/plain', 'committed', true],
    ['markdown file upload', 'file', 'text/markdown', 'committed', true],
    ['text/plain email', 'email', 'text/plain', 'committed', true],
    ['web clip', 'web', 'text/plain', 'committed', true],
    // Non-text, non-audio payloads have no applicable extractor (yet).
    ['pdf file upload', 'file', 'application/pdf', 'committed', false],
    ['image file upload', 'file', 'image/png', 'committed', false],
  ])('%s → %s', (_name, sourceType, contentType, uploadStatus, expected) => {
    expect(
      extractor.appliesTo(fakeItem({ sourceType, contentType, uploadStatus })),
    ).toBe(expected);
  });

  it('does not apply to an item without a source payload', () => {
    expect(extractor.appliesTo(fakeItem({ sourceType: 'text' }))).toBe(false);
  });
});

describe('TranscriptionService.enqueueTranscription (passthrough)', () => {
  function build() {
    const added: { kind: string; provider: string }[] = [];
    const enqueued: TranscriptionJob[] = [];
    const inbox = {
      addExtraction: async (_itemId: string, kind: string, provider: string) => {
        added.push({ kind, provider });
        return { id: 'extraction-1' };
      },
    } as unknown as InboxService;
    const provider = { id: 'speech:whisper' } as TranscriptionProvider;
    const queue: TranscriptionQueue = {
      enqueue: async (job) => {
        enqueued.push(job);
      },
    };
    return { service: new TranscriptionService(inbox, provider, queue), added, enqueued };
  }

  it('records the text-passthrough provider id and flags the job', async () => {
    const { service, added, enqueued } = build();
    await service.enqueueTranscription('item-1', {
      storageKey: 'key-1',
      contentType: 'text/plain',
      passthrough: true,
    });
    expect(added).toEqual([
      { kind: 'transcription', provider: TEXT_PASSTHROUGH_PROVIDER_ID },
    ]);
    expect(enqueued[0].passthrough).toBe(true);
  });

  it('keeps the speech provider id for audio jobs', async () => {
    const { service, added, enqueued } = build();
    await service.enqueueTranscription('item-1', {
      storageKey: 'key-1',
      contentType: 'audio/mpeg',
    });
    expect(added).toEqual([{ kind: 'transcription', provider: 'speech:whisper' }]);
    expect(enqueued[0].passthrough).toBeUndefined();
  });
});

describe('TranscriptionProcessor passthrough', () => {
  function build(opts: { text?: string; storageError?: Error } = {}) {
    const completions: unknown[] = [];
    const statuses: string[] = [];
    const inbox = {
      setExtractionStatus: async (_id: string, status: string) => {
        statuses.push(status);
      },
      completeExtraction: async (_id: string, result: unknown) => {
        completions.push(result);
      },
    } as unknown as InboxService;
    const storage = {
      getObjectStream: async () => {
        if (opts.storageError) throw opts.storageError;
        return Readable.from([Buffer.from(opts.text ?? '')]);
      },
      createInternalPresignedGetUrl: async () => {
        throw new Error('presign must not be called for passthrough');
      },
    } as unknown as StorageService;
    const transcribe = jest.fn(async () => ({ text: 'from-provider' }));
    const provider = { id: 'speech:test', transcribe } as unknown as TranscriptionProvider;
    return {
      processor: new TranscriptionProcessor(inbox, storage, provider),
      completions,
      statuses,
      transcribe,
    };
  }

  const job: TranscriptionJob = {
    extractionId: 'extraction-1',
    inboxItemId: 'item-1',
    storageKey: 'key-1',
    contentType: 'text/plain',
    passthrough: true,
  };

  it('copies the stored text into the row without calling the provider', async () => {
    const { processor, completions, statuses, transcribe } = build({
      text: 'Buy milk\nand call Anna.',
    });
    await processor.process(job);
    expect(statuses).toEqual(['processing']);
    expect(completions).toEqual([
      { status: 'succeeded', content: 'Buy milk\nand call Anna.' },
    ]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('marks the row failed and rethrows when the blob cannot be read', async () => {
    const { processor, completions, transcribe } = build({
      storageError: new Error('blob gone'),
    });
    await expect(processor.process(job)).rejects.toThrow('blob gone');
    expect(completions).toEqual([{ status: 'failed', error: 'blob gone' }]);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
