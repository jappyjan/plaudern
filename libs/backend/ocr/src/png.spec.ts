import { inflateSync } from 'node:zlib';
import { encodeRgbaPng } from './png';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Read the four IHDR fields we care about from an encoded PNG. */
function readIhdr(png: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  // 8-byte signature, then IHDR chunk: 4-byte length + "IHDR" + 13-byte data.
  const data = png.subarray(16, 29);
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colorType: data[9],
  };
}

describe('encodeRgbaPng', () => {
  it('produces a valid PNG signature and RGBA IHDR', () => {
    const width = 2;
    const height = 2;
    const rgba = Buffer.alloc(width * height * 4, 0xff);
    const png = encodeRgbaPng(rgba, width, height);

    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(readIhdr(png)).toEqual({ width, height, bitDepth: 8, colorType: 6 });
  });

  it('round-trips pixel data through the IDAT (filter byte + scanlines)', () => {
    const width = 2;
    const height = 1;
    // Two distinct pixels so a channel swap or stride bug would show up.
    const rgba = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
    const png = encodeRgbaPng(rgba, width, height);

    // Locate the IDAT chunk and inflate it: expect [filter=0, ...rgba row].
    const idatStart = png.indexOf(Buffer.from('IDAT', 'latin1')) + 4;
    const idatLen = png.readUInt32BE(idatStart - 8);
    const inflated = inflateSync(png.subarray(idatStart, idatStart + idatLen));
    expect([...inflated]).toEqual([0, 10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('throws when the buffer is smaller than width*height*4', () => {
    expect(() => encodeRgbaPng(Buffer.alloc(4), 2, 2)).toThrow(/too small/);
  });
});
