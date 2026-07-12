import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PdfRasterizer, DEFAULT_PDF_MAX_PAGES } from './pdf-rasterizer';

const PDF = readFileSync(join(__dirname, '__fixtures__', 'three-page.pdf'));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

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
      expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
      expect(png.length).toBeGreaterThan(100);
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
});
