import { crc32, deflateSync } from "node:zlib";
import { bytesPerPixel, type Framebuffer } from "./vnc-screen-reader.js";

/**
 * Encodes a frame as an 8-bit RGB PNG (https://www.w3.org/TR/png-3/), with
 * no filtering: screens are mostly flat colour, which deflate already
 * shrinks well (a 1280x800 browser window is a few tens of kilobytes), and
 * PNG keeps text sharp where JPEG would smear it.
 */
export function encodePng(frame: Framebuffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(frame.width, 0);
  header.writeUInt32BE(frame.height, 4);
  header.writeUInt8(8, 8); // bits per sample
  header.writeUInt8(2, 9); // colour type: RGB
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(toScanlines(frame), { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Each row is a filter byte (0, none) followed by red, green and blue for each pixel. */
function toScanlines({ width, height, pixels }: Framebuffer): Buffer {
  const rowLength = 1 + width * 3;
  const scanlines = Buffer.alloc(rowLength * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const source = (row * width + column) * bytesPerPixel;
      const target = row * rowLength + 1 + column * 3;
      scanlines[target] = pixels[source + 2] ?? 0;
      scanlines[target + 1] = pixels[source + 1] ?? 0;
      scanlines[target + 2] = pixels[source] ?? 0;
    }
  }
  return scanlines;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  // PNG's checksum is the same CRC-32 that zlib computes.
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}
