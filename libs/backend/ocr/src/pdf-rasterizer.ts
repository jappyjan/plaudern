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
/**
 * Cap on the RAW RGBA bitmap one page may allocate (width × height × 4 at the
 * effective scale) — ≈ a 4096×4096 page. Page pixel count comes from the PDF's
 * MediaBox, which is UNCORRELATED with file size: a tiny (bytes-wise) PDF can
 * declare a gigantic page and OOM the worker if we render first and check
 * later. So this is enforced BEFORE any render: the scale is clamped down to
 * fit, and a page that can't fit even at `MIN_RENDER_SCALE` is skipped.
 */
export const MAX_PAGE_RAW_RGBA_BYTES = 64 * 1024 * 1024;
/** Below this render scale the text is too small to OCR — skip the page instead. */
export const MIN_RENDER_SCALE = 0.25;

/** One rasterized PDF: PNG bytes per rendered page, plus the truncation verdict. */
export interface RasterizedPdf {
  /**
   * One entry per processed page, in document order: PNG image bytes, or `null`
   * for a page whose declared dimensions were too large to rasterize safely
   * (the caller records a skip marker for it instead of failing the document).
   */
  pages: Array<Buffer | null>;
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
 * Defensive caps, all reported rather than thrown:
 *   - page COUNT (configurable `OCR_PDF_MAX_PAGES`, default 50) → `truncated`;
 *   - page PIXEL AREA (`MAX_PAGE_RAW_RGBA_BYTES`, checked BEFORE rendering via
 *     the page's declared size) → the scale is clamped down to fit, and a page
 *     too large even at `MIN_RENDER_SCALE` yields `null` (skipped).
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
   * via `truncated` and an oversized page as a `null` entry, never thrown.
   */
  async rasterize(
    pdfBytes: Buffer,
    opts?: { maxPages?: number; scale?: number },
  ): Promise<RasterizedPdf> {
    const cap = Math.max(1, opts?.maxPages ?? this.maxPages);
    const requestedScale = opts?.scale ?? this.renderScale;
    const library = await this.getLibrary();
    const doc = await library.loadDocument(new Uint8Array(pdfBytes));
    try {
      const totalPages = doc.getPageCount();
      const renderCount = Math.min(totalPages, cap);
      const pages: Array<Buffer | null> = [];
      for (let i = 0; i < renderCount; i++) {
        const page = doc.getPage(i);
        const scale = this.safeScaleFor(page, requestedScale, i);
        if (scale === null) {
          pages.push(null);
          continue;
        }
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

  /**
   * The scale to safely render one page at, decided BEFORE any bitmap is
   * allocated: from the page's declared size (points, from the MediaBox),
   * clamp the requested scale so the raw RGBA stays under
   * `MAX_PAGE_RAW_RGBA_BYTES`. Returns `null` (= skip the page) when even
   * `MIN_RENDER_SCALE` would blow the budget, or when the declared size is
   * degenerate.
   */
  private safeScaleFor(
    page: { getOriginalSize(): { originalWidth: number; originalHeight: number } },
    requestedScale: number,
    pageIndex: number,
  ): number | null {
    const { originalWidth, originalHeight } = page.getOriginalSize();
    if (
      !Number.isFinite(originalWidth) ||
      !Number.isFinite(originalHeight) ||
      originalWidth <= 0 ||
      originalHeight <= 0
    ) {
      this.logger.warn(
        `page ${pageIndex + 1} has a degenerate size (${originalWidth}x${originalHeight} pt) — skipping`,
      );
      return null;
    }
    const rawBytesAt = (s: number) =>
      Math.ceil(originalWidth * s) * Math.ceil(originalHeight * s) * 4;
    if (rawBytesAt(requestedScale) <= MAX_PAGE_RAW_RGBA_BYTES) return requestedScale;

    // Largest scale whose raw bitmap fits the budget (slightly conservative).
    const fitted = Math.sqrt(
      MAX_PAGE_RAW_RGBA_BYTES / (originalWidth * originalHeight * 4),
    );
    if (fitted < MIN_RENDER_SCALE) {
      this.logger.warn(
        `page ${pageIndex + 1} is too large to rasterize ` +
          `(${originalWidth}x${originalHeight} pt would need scale ${fitted.toFixed(3)} ` +
          `< ${MIN_RENDER_SCALE}) — skipping`,
      );
      return null;
    }
    this.logger.warn(
      `page ${pageIndex + 1} is oversized (${originalWidth}x${originalHeight} pt); ` +
        `clamping render scale ${requestedScale} → ${fitted.toFixed(3)}`,
    );
    return fitted;
  }

  /**
   * Lazily initialize the WASM library once and reuse it across jobs. A FAILED
   * init is not cached — the promise is cleared so the next job retries instead
   * of permanently poisoning the worker after one transient failure.
   */
  private getLibrary(): Promise<PDFiumLibrary> {
    if (!this.libraryPromise) {
      this.libraryPromise = PDFiumLibrary.init().catch((err: unknown) => {
        this.libraryPromise = null;
        throw err;
      });
    }
    return this.libraryPromise;
  }
}
