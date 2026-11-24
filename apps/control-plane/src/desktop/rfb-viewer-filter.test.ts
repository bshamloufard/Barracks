import { describe, expect, it } from "vitest";
import { largestClipboardInBytes, RfbViewerFilter } from "./rfb-viewer-filter.js";

/** What noVNC sends to open a session: version 3.8, security None, ClientInit asking not to share. */
const handshake = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1]), Buffer.from([0])]);

const setPixelFormat = Buffer.from([
  0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
]);
const updateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const pointerEvent = Buffer.from([5, 1, 0, 10, 0, 20]);
const enableContinuousUpdates = Buffer.from([150, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const clientFence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 2, 0xaa, 0xbb]);
const setDesktopSize = Buffer.concat([Buffer.from([251, 0, 5, 0, 3, 32, 1, 0]), Buffer.alloc(16)]);
const qemuKeyEvent = Buffer.from([255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 0x1e]);

function clientCutText(text: string, isExtended = false): Buffer {
  const header = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
  header.writeInt32BE(isExtended ? -text.length : text.length, 4);
  return Buffer.concat([header, Buffer.from(text, "latin1")]);
}

function setEncodings(encodings: number[]): Buffer {
  const message = Buffer.alloc(4 + 4 * encodings.length);
  message.writeUInt8(2, 0);
  message.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, index) => {
    message.writeInt32BE(encoding, 4 + 4 * index);
  });
  return message;
}

function readEncodings(message: Buffer): number[] {
  return Array.from({ length: message.readUInt16BE(2) }, (_, index) =>
    message.readInt32BE(4 + 4 * index),
  );
}

type Filtered = { filter: RfbViewerFilter; inputsForwarded: number };

function createFilter(holdsControl: () => boolean): Filtered {
  const filtered: Filtered = {
    inputsForwarded: 0,
    filter: new RfbViewerFilter({
      isInputAllowed: holdsControl,
      onInputForwarded: () => {
        filtered.inputsForwarded += 1;
      },
    }),
  };
  filtered.filter.accept(handshake);
  return filtered;
}

const everyInputMessage = [
  keyEvent,
  pointerEvent,
  clientCutText("hello"),
  clientCutText("caps", true),
  setDesktopSize,
  qemuKeyEvent,
];
const everyNonInputMessage = [setPixelFormat, updateRequest, enableContinuousUpdates, clientFence];

describe("the viewer filter's handshake", () => {
  it("passes the version and security type on, and makes every viewer share the desktop", () => {
    const { filter } = createFilter(() => false);
    const fresh = new RfbViewerFilter({ isInputAllowed: () => false, onInputForwarded: () => {} });

    expect([...fresh.accept(handshake)]).toEqual([...handshake.subarray(0, 13), 1]);
    expect(filter.accept(updateRequest)).toEqual(updateRequest);
  });

  it("refuses another protocol version, and a security type the desktop does not offer", () => {
    const oldVersion = new RfbViewerFilter({
      isInputAllowed: () => true,
      onInputForwarded: () => {},
    });
    const otherSecurity = new RfbViewerFilter({
      isInputAllowed: () => true,
      onInputForwarded: () => {},
    });

    expect(() => oldVersion.accept(Buffer.from("RFB 003.003\n"))).toThrow(/protocol version/);
    expect(() => otherSecurity.accept(Buffer.from("RFB 003.008\n\u0002"))).toThrow(/security type/);
  });
});

describe("the viewer filter, for a viewer holding control", () => {
  it("passes every message on unchanged, and notes each input", () => {
    const filtered = createFilter(() => true);

    for (const message of [...everyNonInputMessage, ...everyInputMessage]) {
      expect(filtered.filter.accept(message)).toEqual(message);
    }
    expect(filtered.inputsForwarded).toBe(everyInputMessage.length);
  });
});

describe("the viewer filter, for a viewer only watching", () => {
  it("drops keyboard, pointer, clipboard and screen-size messages, and counts them", () => {
    const filtered = createFilter(() => false);

    for (const message of everyInputMessage) {
      expect(filtered.filter.accept(message)).toEqual(Buffer.alloc(0));
    }
    expect(filtered.filter.droppedInputCount).toBe(everyInputMessage.length);
    expect(filtered.inputsForwarded).toBe(0);
  });

  it("still passes what asks how the desktop looks", () => {
    const { filter } = createFilter(() => false);

    for (const message of everyNonInputMessage) {
      expect(filter.accept(message)).toEqual(message);
    }
  });

  it("asks whether the viewer holds control at each message, so taking control takes effect at once", () => {
    let holdsControl = false;
    const { filter } = createFilter(() => holdsControl);

    const whileWatching = filter.accept(pointerEvent);
    holdsControl = true;
    const whileControlling = filter.accept(pointerEvent);

    expect(whileWatching).toEqual(Buffer.alloc(0));
    expect(whileControlling).toEqual(pointerEvent);
  });
});

describe("the viewer filter's reading of messages", () => {
  it("reads messages split across frames, byte by byte", () => {
    const { filter } = createFilter(() => true);
    const stream = Buffer.concat([keyEvent, clientCutText("split"), updateRequest]);

    const forwarded = [...stream].map((byte) => filter.accept(Buffer.from([byte])));

    expect(Buffer.concat(forwarded)).toEqual(stream);
    expect(forwarded.filter((bytes) => bytes.length > 0)).toHaveLength(3);
  });

  it("reads several messages joined in one frame, keeping some and dropping others", () => {
    const { filter } = createFilter(() => false);

    const forwarded = filter.accept(
      Buffer.concat([updateRequest, keyEvent, pointerEvent, clientFence]),
    );

    expect(forwarded).toEqual(Buffer.concat([updateRequest, clientFence]));
  });

  it("refuses a message type it does not know, such as xvp", () => {
    const { filter } = createFilter(() => true);

    expect(() => filter.accept(Buffer.from([250, 0, 1, 2]))).toThrow(/unknown type 250/);
  });

  it("refuses a QEMU message other than the extended key event", () => {
    const { filter } = createFilter(() => true);

    expect(() => filter.accept(Buffer.from([255, 1, 0, 0]))).toThrow(/QEMU message/);
  });

  it("refuses clipboard text past its limit, before it has all arrived", () => {
    const { filter } = createFilter(() => true);
    const header = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
    header.writeInt32BE(largestClipboardInBytes + 1, 4);

    expect(() => filter.accept(header)).toThrow(/clipboard/);
  });

  it("refuses an absurd list of encodings and a fence with more payload than allowed", () => {
    const encodingsHeader = Buffer.from([2, 0, 0xff, 0xff]);
    const oversizedFence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 65]);

    expect(() => createFilter(() => true).filter.accept(encodingsHeader)).toThrow(/encodings/);
    expect(() => createFilter(() => true).filter.accept(oversizedFence)).toThrow(/fence/);
  });
});

describe("the viewer filter's encodings", () => {
  it("keeps only the encodings on its list, dropping H.264 and the rest", () => {
    const { filter } = createFilter(() => false);
    const asked = [50, 7, -260, 16, 1, 0, -307, -316, -309, 0x574d5664, -26, -254, -239, -308];

    const forwarded = filter.accept(setEncodings(asked));

    expect(readEncodings(forwarded)).toEqual([7, -260, 16, 1, 0, -26, -254, -239, -308]);
  });
});
