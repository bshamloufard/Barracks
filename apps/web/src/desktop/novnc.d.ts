/**
 * noVNC (`@novnc/novnc` 1.7.0) ships no type declarations, and the
 * community ones lag behind it, so this declares the part of its API
 * (https://github.com/novnc/noVNC/blob/v1.7.0/docs/API.md) the viewer uses.
 */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    /** `channel` may be an already open WebSocket, which noVNC then speaks VNC on. */
    constructor(target: HTMLElement, channel: string | WebSocket, options?: { shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
  }
}
