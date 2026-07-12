import type { InboxService } from '@plaudern/inbox';
import type { StorageService } from '@plaudern/storage';
import type { TranscriptionService } from '@plaudern/transcription';
import { OcrProcessor } from './ocr.processor';
import type { OcrInput, OcrProvider } from './ocr.provider';
import type { OcrJob } from './ocr.job';
import type { PdfRasterizer, RasterizedPdf } from './pdf-rasterizer';

const JOB: OcrJob = {
  extractionId: 'ext-1',
  inboxItemId: 'item-1',
  storageKey: 'blobs/doc.png',
  contentType: 'image/png',
  filename: 'doc.png',
};

const PDF_JOB: OcrJob = {
  extractionId: 'ext-2',
  inboxItemId: 'item-1',
  storageKey: 'blobs/doc.pdf',
  contentType: 'application/pdf',
  filename: 'contract.pdf',
};

/** Storage stand-in that streams a fixed buffer for the document blob. */
function fakeStorage(bytes: Buffer = Buffer.from('fake image bytes')): StorageService {
  return {
    async getObjectStream() {
      return (async function* () {
        yield bytes;
      })();
    },
  } as unknown as StorageService;
}

function fakeInbox(): {
  service: InboxService;
  completed: Array<{ id: string; result: { status: string; content?: string; language?: string } }>;
} {
  const completed: Array<{
    id: string;
    result: { status: string; content?: string; language?: string };
  }> = [];
  const service = {
    async setExtractionStatus() {
      /* no-op */
    },
    // The processor loads the item to attribute the per-user AI call (OcrJob
    // carries no userId).
    async getItemById(id: string) {
      return { id, userId: 'user-1' };
    },
    async completeExtraction(
      id: string,
      result: { status: string; content?: string; language?: string },
    ) {
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

/** A rasterizer that never sees a PDF — the single-image path (JJ-30 shape). */
function imageRasterizer(): PdfRasterizer {
  return { isPdf: () => false } as unknown as PdfRasterizer;
}

/** A rasterizer that yields `pages` fake PNGs for the PDF path. */
function pdfRasterizer(result: RasterizedPdf): PdfRasterizer {
  return {
    isPdf: () => true,
    rasterize: async () => result,
  } as unknown as PdfRasterizer;
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
      imageRasterizer(),
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
      imageRasterizer(),
    );

    await processor.process(JOB);

    expect(record).not.toHaveBeenCalled();
  });

  it('OCRs a PDF page-by-page and concatenates the text behind [page N] markers', async () => {
    const { service: inbox, completed } = fakeInbox();
    const record = jest.fn(async () => 'transcription-1');
    const transcription = { recordExtractedText: record } as unknown as TranscriptionService;

    // One vision call per page; return text derived from the per-page filename
    // hint so we can prove each page was sent separately.
    const recognize = jest.fn(async (_userId: string, input: OcrInput) => ({
      text: input.filename?.includes('page 1/2') ? 'first page text' : 'second page text',
      language: 'en',
      model: 'vision-x',
    }));
    const provider: OcrProvider = { id: 'test:ocr', recognize };

    const processor = new OcrProcessor(
      inbox,
      fakeStorage(),
      transcription,
      provider,
      pdfRasterizer({
        pages: [Buffer.from('png-1'), Buffer.from('png-2')],
        totalPages: 2,
        truncated: false,
      }),
    );

    await processor.process(PDF_JOB);

    // Two separate vision calls, one per page.
    expect(recognize).toHaveBeenCalledTimes(2);
    const expected = '[page 1]\nfirst page text\n\n[page 2]\nsecond page text';
    expect(completed[0].result).toMatchObject({ status: 'succeeded', content: expected, language: 'en' });
    // The page markers survive into the bridged transcription (downstream input).
    expect(record).toHaveBeenCalledWith('item-1', { content: expected, language: 'en' });
  });

  it('records truncation inline when a PDF exceeds the page cap (never fails)', async () => {
    const { service: inbox, completed } = fakeInbox();
    const transcription = {
      recordExtractedText: jest.fn(async () => 't'),
    } as unknown as TranscriptionService;

    const processor = new OcrProcessor(
      inbox,
      fakeStorage(),
      transcription,
      fakeProvider({ text: 'page body', language: 'en' }),
      pdfRasterizer({
        pages: [Buffer.from('png-1'), Buffer.from('png-2')],
        totalPages: 5,
        truncated: true,
      }),
    );

    await processor.process(PDF_JOB);

    expect(completed[0].result.status).toBe('succeeded');
    expect(completed[0].result.content).toBe(
      '[page 1]\npage body\n\n[page 2]\npage body\n\n' +
        '[truncated: OCR processed the first 2 of 5 pages]',
    );
  });

  it('keeps a skip marker (and correct numbering) for a page the rasterizer refused', async () => {
    const { service: inbox, completed } = fakeInbox();
    const transcription = {
      recordExtractedText: jest.fn(async () => 't'),
    } as unknown as TranscriptionService;
    const recognize = jest.fn(async () => ({ text: 'page body', language: 'en' }));

    const processor = new OcrProcessor(
      inbox,
      fakeStorage(),
      transcription,
      { id: 'test:ocr', recognize },
      // Page 2 was refused pre-render (oversized MediaBox) → null entry.
      pdfRasterizer({
        pages: [Buffer.from('png-1'), null, Buffer.from('png-3')],
        totalPages: 3,
        truncated: false,
      }),
    );

    await processor.process(PDF_JOB);

    // No vision call for the skipped page.
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(completed[0].result).toMatchObject({
      status: 'succeeded',
      content:
        '[page 1]\npage body\n\n' +
        '[page 2]\n[page image too large to OCR]\n\n' +
        '[page 3]\npage body',
    });
  });

  it('fails gracefully (no rasterize, no vision call) for an over-sized PDF blob', async () => {
    const { service: inbox, completed } = fakeInbox();
    const transcription = {
      recordExtractedText: jest.fn(async () => 't'),
    } as unknown as TranscriptionService;
    const recognize = jest.fn(async () => ({ text: 'unreachable' }));
    const rasterize = jest.fn();
    const rasterizer = { isPdf: () => true, rasterize } as unknown as PdfRasterizer;

    const processor = new OcrProcessor(
      inbox,
      fakeStorage(Buffer.alloc(13 * 1024 * 1024)), // > 12MB PDF cap
      transcription,
      { id: 'test:ocr', recognize },
      rasterizer,
    );

    await expect(processor.process(PDF_JOB)).rejects.toThrow(/PDF is too large to OCR/);

    expect(rasterize).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(completed[0].result.status).toBe('failed');
    expect((completed[0].result as { error?: string }).error).toMatch(/PDF is too large/);
  });
});
