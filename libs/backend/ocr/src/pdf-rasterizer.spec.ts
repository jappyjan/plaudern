import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import {
  PdfRasterizer,
  DEFAULT_PDF_MAX_PAGES,
  MAX_PAGE_RAW_RGBA_BYTES,
  MIN_RENDER_SCALE,
} from './pdf-rasterizer';

const PDF = readFileSync(join(__dirname, '__fixtures__', 'three-page.pdf'));
/** Page 1: normal 300x200pt. Page 2: absurd 200000x200000pt MediaBox (DoS shape). */
const OVERSIZED_PDF = readFileSync(join(__dirname, '__fixtures__', 'oversized-page.pdf'));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Read width/height out of a PNG's IHDR. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A stand-in page reporting the given size in points. */
function pageOfSize(originalWidth: number, originalHeight: number) {
  return { getOriginalSize: () => ({ originalWidth, originalHeight }) };
}

/** Call the private pre-render scale guard directly (no bitmap is allocated). */
function safeScale(r: PdfRasterizer, w: number, h: number, scale: number): number | null {
  return (r as unknown as {
    safeScaleFor(p: unknown, s: number, i: number): number | null;
  }).safeScaleFor(pageOfSize(w, h), scale, 0);
}

describe('PdfRasterizer', () => {
  describe('isPdf', () => {
    const r = new PdfRasterizer();
    it('detects PDFs by content type', () => {
      expect(r.isPdf('application/pdf')).toBe(true);
      expect(r.isPdf('APPLICATION/PDF; charset=binary')).toBe(true);
    });
    it('detects PDFs by the %PDF- magic even when the content type lies', () => {
      expect(r.isPdf('application/octet-stream', PDF)).toBe(true);
    });
    it('does not treat images as PDFs', () => {
      expect(r.isPdf('image/png', Buffer.from('not a pdf'))).toBe(false);
      expect(r.isPdf(null, Buffer.from([0x89, 0x50]))).toBe(false);
    });
  });

  it('renders every page to a PNG image in document order', async () => {
    const { pages, totalPages, truncated } = await new PdfRasterizer().rasterize(PDF);
    expect(totalPages).toBe(3);
    expect(truncated).toBe(false);
    expect(pages).toHaveLength(3);
    for (const png of pages) {
      expect(png).not.toBeNull();
      expect((png as Buffer).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
      expect((png as Buffer).length).toBeGreaterThan(100);
    }
  });

  it('caps the number of rendered pages and reports truncation', async () => {
    const { pages, totalPages, truncated } = await new PdfRasterizer().rasterize(PDF, {
      maxPages: 2,
    });
    expect(totalPages).toBe(3);
    expect(pages).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('defaults the page cap to DEFAULT_PDF_MAX_PAGES when unconfigured', () => {
    expect(new PdfRasterizer().maxPages).toBe(DEFAULT_PDF_MAX_PAGES);
  });

  it('reads and clamps OCR_PDF_MAX_PAGES from config', () => {
    const cfg = (value: unknown) =>
      new PdfRasterizer({ get: () => value } as never).maxPages;
    expect(cfg('10')).toBe(10);
    expect(cfg(0)).toBe(DEFAULT_PDF_MAX_PAGES); // invalid → default
    expect(cfg(100000)).toBe(500); // clamped to the ceiling
  });

  describe('pre-render page-size guard (MediaBox DoS)', () => {
    const r = new PdfRasterizer();

    it('passes the requested scale through for a normal page', () => {
      // A4-ish page at scale 2 → ~1190x1684 px ≈ 8MB raw, far under budget.
      expect(safeScale(r, 595, 842, 2)).toBe(2);
    });

    it('clamps the scale BEFORE rendering when the bitmap would exceed the budget', () => {
      // 5000x5000pt at scale 2 → 10000x10000 px = 400MB raw. Must clamp so no
      // render is ever attempted at the requested scale.
      const clamped = safeScale(r, 5000, 5000, 2);
      expect(clamped).not.toBeNull();
      expect(clamped as number).toBeLessThan(2);
      expect(clamped as number).toBeGreaterThanOrEqual(MIN_RENDER_SCALE);
      const raw =
        Math.ceil(5000 * (clamped as number)) * Math.ceil(5000 * (clamped as number)) * 4;
      expect(raw).toBeLessThanOrEqual(MAX_PAGE_RAW_RGBA_BYTES);
    });

    it('refuses (null, no render) a page too large even at the minimum scale', () => {
      expect(safeScale(r, 200000, 200000, 2)).toBeNull();
    });

    it('refuses a page with a degenerate declared size', () => {
      expect(safeScale(r, 0, 200, 2)).toBeNull();
      expect(safeScale(r, Number.NaN, 200, 2)).toBeNull();
    });

    it('skips an absurd-MediaBox page end-to-end while still rendering the normal one', async () => {
      const { pages, totalPages, truncated } = await r.rasterize(OVERSIZED_PDF);
      expect(totalPages).toBe(2);
      expect(truncated).toBe(false);
      expect(pages).toHaveLength(2);
      // Page 1 (300x200pt) renders normally…
      expect(pages[0]).not.toBeNull();
      expect((pages[0] as Buffer).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
      const { width, height } = pngSize(pages[0] as Buffer);
      expect(width * height * 4).toBeLessThanOrEqual(MAX_PAGE_RAW_RGBA_BYTES);
      // …page 2 (200000x200000pt) is skipped without any bitmap allocation.
      expect(pages[1]).toBeNull();
    });
  });

  it('retries WASM init after a transient failure instead of caching the rejection', async () => {
    const spy = jest
      .spyOn(PDFiumLibrary, 'init')
      .mockRejectedValueOnce(new Error('transient wasm init failure'));
    const r = new PdfRasterizer();
    await expect(r.rasterize(PDF)).rejects.toThrow('transient wasm init failure');
    spy.mockRestore(); // subsequent init calls hit the real implementation
    const { totalPages } = await r.rasterize(PDF);
    expect(totalPages).toBe(3);
  });
});
