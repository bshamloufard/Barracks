import { bytesPerPixel, type DisplaySize, type Framebuffer } from "./vnc-screen-reader.js";

/**
 * The model works in the pixels of the screenshots it is shown. They are
 * the display's own pixels unless the display is larger than this, when
 * they are scaled down to fit and every coordinate the model gives is
 * scaled back up. 1280x800, the sandbox's own display, is within the image
 * limits of every model in use and of Pi's own resizing (2000x2000 unless a
 * model says otherwise), so Pi never rescales a screenshot behind the
 * tool's back and leaves the model to multiply coordinates itself.
 */
export const largestScreenshotSize: DisplaySize = { width: 1280, height: 800 };

/** How the screenshots the model sees relate to the display. */
export type ScreenGeometry = { display: DisplaySize; screenshot: DisplaySize };

export type ScreenPoint = { x: number; y: number };

export function screenGeometryFor(display: DisplaySize): ScreenGeometry {
  const shrinkFactor = Math.max(
    display.width / largestScreenshotSize.width,
    display.height / largestScreenshotSize.height,
    1,
  );
  return {
    display,
    screenshot: {
      width: Math.round(display.width / shrinkFactor),
      height: Math.round(display.height / shrinkFactor),
    },
  };
}

/**
 * Where on the display a point the model gave in screenshot pixels is.
 * Throws, with a message for the model, if it is off the screenshot.
 */
export function toDisplayPoint(
  [x, y]: readonly [number, number],
  geometry: ScreenGeometry,
): ScreenPoint {
  const { screenshot, display } = geometry;
  const isOnScreenshot = x >= 0 && y >= 0 && x < screenshot.width && y < screenshot.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !isOnScreenshot) {
    throw new Error(
      `(${x}, ${y}) is off the screen; coordinates go from (0, 0) to (${screenshot.width - 1}, ${screenshot.height - 1}).`,
    );
  }
  return {
    x: Math.min(display.width - 1, Math.round((x * display.width) / screenshot.width)),
    y: Math.min(display.height - 1, Math.round((y * display.height) / screenshot.height)),
  };
}

/**
 * Shrinks a frame to the screenshot's size by averaging each area of
 * pixels, which keeps thin text legible better than skipping pixels does.
 * Pi's own resizer is not used: it switches to JPEG whenever that is
 * smaller, which blurs text.
 */
export function shrinkFrame(frame: Framebuffer, target: DisplaySize): Framebuffer {
  if (target.width === frame.width && target.height === frame.height) {
    return frame;
  }
  const pixels = Buffer.alloc(target.width * target.height * bytesPerPixel);
  for (let targetRow = 0; targetRow < target.height; targetRow += 1) {
    const rows = sourceSpan(targetRow, target.height, frame.height);
    for (let targetColumn = 0; targetColumn < target.width; targetColumn += 1) {
      const columns = sourceSpan(targetColumn, target.width, frame.width);
      const average = averageArea(frame, rows, columns);
      average.copy(pixels, (targetRow * target.width + targetColumn) * bytesPerPixel);
    }
  }
  return { ...target, pixels };
}

type Span = { start: number; end: number };

function sourceSpan(targetIndex: number, targetLength: number, sourceLength: number): Span {
  const start = Math.floor((targetIndex * sourceLength) / targetLength);
  const end = Math.max(start + 1, Math.floor(((targetIndex + 1) * sourceLength) / targetLength));
  return { start, end };
}

function averageArea(frame: Framebuffer, rows: Span, columns: Span): Buffer {
  const sums = [0, 0, 0];
  for (let row = rows.start; row < rows.end; row += 1) {
    for (let column = columns.start; column < columns.end; column += 1) {
      const offset = (row * frame.width + column) * bytesPerPixel;
      for (let channel = 0; channel < 3; channel += 1) {
        sums[channel] = (sums[channel] ?? 0) + (frame.pixels[offset + channel] ?? 0);
      }
    }
  }
  const pixelCount = (rows.end - rows.start) * (columns.end - columns.start);
  return Buffer.from([...sums.map((sum) => Math.round(sum / pixelCount)), 0]);
}
