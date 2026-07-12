import { crc32, deflateSync } from 'node:zlib';

/**
 * Minimal, dependency-free PNG encoder for 8-bit RGBA pixel buffers.
 *
 * The PDF rasterizer (`PdfRasterizer`) renders each page to a raw RGBA bitmap via
 * pdfium (WASM); a vision model needs a real image format, so we encode that
 * bitmap to PNG here. We deliberately avoid a native image library (sharp,
 * node-canvas) — those pull node-gyp/native binaries that would break the
 * hoisted prod-deps deploy. Node's built-in `zlib` (deflate + crc32) is all a
 * PNG needs: signature, IHDR, one zlib-compressed IDAT of filtered scanlines,
 * and IEND.
 */
export function encodeRgbaPng(rgba: Buffer, width: number, height: number): Buffer {
  const stride = width * 4;
  if (rgba.length < stride * height) {
    throw new Error(
      `RGBA buffer too small: got ${rgba.length} bytes, need ${stride * height} for ${width}x${height}`,
    );
  }

  // Prefix every scanline with filter byte 0 (None), then deflate the lot.
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha (RGBA)
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Frame one PNG chunk: length + type + data + CRC32 over (type + data). */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}
