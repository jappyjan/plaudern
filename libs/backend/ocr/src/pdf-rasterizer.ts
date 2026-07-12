import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { encodeRgbaPng } from './png';

/** Default cap on how many PDF pages we rasterize + OCR for one document. */
export const DEFAULT_PDF_MAX_PAGES = 50;
/** Absolute ceiling so a misconfiguration can't unleash thousands of vision calls. */
export const PDF_MAX_PAGES_CEILING = 500;
/**
 * Render scale (1 ≈ 72 DPI). 2 ≈ 144 DPI, a good legibility/size trade-off for
 * OCR — high enough for small print, small enough to keep each PNG well under
 * the vision request cap.
 */
export const DEFAULT_PDF_RENDER_SCALE = 2;

/** One rasterized PDF: PNG bytes per rendered page, plus the truncation verdict. */
export interface RasterizedPdf {
  /** PNG image bytes, one per rendered page, in document order. */
  pages: Buffer[];
  /** Total pages in the source PDF (before the cap). */
  totalPages: number;
  /** True when `totalPages` exceeded the cap and later pages were dropped. */
  truncated: boolean;
}

/**
 * Rasterizes a PDF to one PNG per page so multi-page documents can be OCR'd
 * page-by-page (JJ-82) — a vision model reads a single image at a time, and the
 * whole-PDF-as-one-data-URL approach (JJ-30) lost per-page structure.
 *
 * Rendering uses pdfium compiled to WASM (`@hyzyla/pdfium`): a pure-JS/WASM
 * runtime dependency with NO native binary / node-gyp / postinstall download, so
 * it survives the hoisted prod-deps deploy and `verify:prod-deps`. pdfium yields
 * a raw RGBA bitmap per page (it renders BGRA + reverse-byte-order = RGBA); we
 * encode that to PNG with a dependency-free encoder (`./png`).
 *
 * Page count is capped (configurable `OCR_PDF_MAX_PAGES`, default 50) so a huge
 * document can't fan out into unbounded vision calls; the overflow is reported
 * via `truncated` rather than throwing.
 */
@Injectable()
export class PdfRasterizer {
  private readonly logger = new Logger(PdfRasterizer.name);
  private libraryPromise: Promise<PDFiumLibrary> | null = null;

  constructor(@Optional() private readonly config?: ConfigService) {}

  /** True when the payload is a PDF, by content type or the `%PDF-` magic. */
  isPdf(contentType?: string | null, bytes?: Buffer): boolean {
    if (contentType && contentType.toLowerCase().includes('application/pdf')) {
      return true;
    }
    if (bytes && bytes.length >= 5) {
      return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    }
    return false;
  }

  /** Configured page cap (`OCR_PDF_MAX_PAGES`), clamped to a sane range. */
  get maxPages(): number {
    const raw = this.config?.get<string | number>('OCR_PDF_MAX_PAGES');
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (!parsed || !Number.isFinite(parsed) || parsed < 1) return DEFAULT_PDF_MAX_PAGES;
    return Math.min(parsed, PDF_MAX_PAGES_CEILING);
  }

  private get renderScale(): number {
    const raw = this.config?.get<string | number>('OCR_PDF_RENDER_SCALE');
    const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
    if (!parsed || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PDF_RENDER_SCALE;
    return parsed;
  }

  /**
   * Render up to `maxPages` (override or configured) pages of `pdfBytes` to PNG.
   * Throws only on an unreadable/corrupt PDF — an over-cap page count is reported
   * via `truncated`, never thrown.
   */
  async rasterize(
    pdfBytes: Buffer,
    opts?: { maxPages?: number; scale?: number },
  ): Promise<RasterizedPdf> {
    const cap = Math.max(1, opts?.maxPages ?? this.maxPages);
    const scale = opts?.scale ?? this.renderScale;
    const library = await this.getLibrary();
    const doc = await library.loadDocument(new Uint8Array(pdfBytes));
    try {
      const totalPages = doc.getPageCount();
      const renderCount = Math.min(totalPages, cap);
      const pages: Buffer[] = [];
      for (let i = 0; i < renderCount; i++) {
        const page = doc.getPage(i);
        const rendered = await page.render({
          scale,
          render: (bitmap) =>
            Promise.resolve(
              encodeRgbaPng(Buffer.from(bitmap.data), bitmap.width, bitmap.height),
            ),
        });
        pages.push(Buffer.from(rendered.data));
      }
      const truncated = totalPages > renderCount;
      if (truncated) {
        this.logger.warn(
          `PDF has ${totalPages} pages; OCR capped at ${renderCount} (OCR_PDF_MAX_PAGES=${cap})`,
        );
      }
      return { pages, totalPages, truncated };
    } finally {
      doc.destroy();
    }
  }

  /** Lazily initialize the WASM library once and reuse it across jobs. */
  private getLibrary(): Promise<PDFiumLibrary> {
    if (!this.libraryPromise) {
      this.libraryPromise = PDFiumLibrary.init();
    }
    return this.libraryPromise;
  }
}
