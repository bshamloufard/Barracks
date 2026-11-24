import { inflateSync } from "node:zlib";

/**
 * Just enough PNG decoding (8-bit RGB or RGBA, not interlaced, every row
 * filter) for the mock model to look at the screenshots the agent's
 * computer tool sends it, so a scripted click lands only if the tool's
 * coordinates match the image the model was shown.
 * https://www.w3.org/TR/png-3/#9Filters
 */
export type DecodedImage = { width: number; height: number; channels: number; pixels: Buffer };

export type ColourMatch = { x: number; y: number; pixelCount: number };

export function decodePng(png: Buffer): DecodedImage {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const imageData: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data.readUInt8(9);
    }
    if (type === "IDAT") {
      imageData.push(data);
    }
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : 3;
  return {
    width,
    height,
    channels,
    pixels: unfilter(inflateSync(Buffer.concat(imageData)), width, height, channels),
  };
}

function unfilter(scanlines: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = scanlines[row * (stride + 1)] ?? 0;
    for (let column = 0; column < stride; column += 1) {
      const value = scanlines[row * (stride + 1) + 1 + column] ?? 0;
      const left = column >= channels ? (pixels[row * stride + column - channels] ?? 0) : 0;
      const up = row > 0 ? (pixels[(row - 1) * stride + column] ?? 0) : 0;
      const upLeft =
        row > 0 && column >= channels ? (pixels[(row - 1) * stride + column - channels] ?? 0) : 0;
      pixels[row * stride + column] = (value + predict(filter, left, up, upLeft)) & 0xff;
    }
  }
  return pixels;
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
    }
    default:
      return 0;
  }
}

/** The centre of the pixels close to `rgb`, if there are enough of them to be a button. */
export function findColour(
  image: DecodedImage,
  [red, green, blue]: readonly [number, number, number],
  smallestPixelCount = 500,
): ColourMatch | undefined {
  let sumX = 0;
  let sumY = 0;
  let pixelCount = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * image.channels;
      const isClose =
        Math.abs((image.pixels[index] ?? 0) - red) < 12 &&
        Math.abs((image.pixels[index + 1] ?? 0) - green) < 12 &&
        Math.abs((image.pixels[index + 2] ?? 0) - blue) < 12;
      if (isClose) {
        sumX += x;
        sumY += y;
        pixelCount += 1;
      }
    }
  }
  if (pixelCount < smallestPixelCount) {
    return undefined;
  }
  return { x: Math.round(sumX / pixelCount), y: Math.round(sumY / pixelCount), pixelCount };
}
