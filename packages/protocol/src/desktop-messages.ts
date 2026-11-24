import { z } from "zod";
import { authenticateMessageSchema } from "./authenticate-message.js";
import { maximumErrorMessageLength } from "./limits.js";
import { parseFrame } from "./parse-frame.js";
import type { ParseResult } from "./parse-result.js";

/**
 * A thread's live desktop, and how it reaches its owner's browser without
 * the sandbox accepting any connection.
 *
 * Inside the sandbox a VNC server listens on loopback only. The desktop
 * travels through a second WebSocket that the sandbox's supervisor opens
 * outward, on request, for one viewer at a time; the control plane splices
 * it to that viewer's WebSocket. The same path works with every provider,
 * and the provider's own address for a service is not involved.
 *
 * The stream handshake, for each viewer:
 * 1. The viewer opens `/threads/{threadId}/desktop`
 *    (`buildDesktopViewerEndpointPath`) and sends `authenticate` as its
 *    first message, exactly as on the thread's client connection (see
 *    `client-messages.ts`): the same token, time limit and byte limit, and
 *    another user's thread is answered as a missing one.
 * 2. The control plane checks that the thread's sandbox is running, that
 *    its supervisor is connected and reports a desktop, and that the thread
 *    has room for another viewer. If not, it sends `desktop_unavailable`
 *    saying why, and closes with `closeCodes.desktopUnavailable`. It never
 *    wakes a stopped sandbox for a viewer.
 * 3. It mints a stream identifier and sends `open_desktop_stream` to the
 *    thread's supervisor, on the supervisor's own connection.
 * 4. The supervisor connects to its VNC server and opens a WebSocket to
 *    `/threads/{threadId}/desktop-streams/{streamId}`
 *    (`buildDesktopStreamEndpointPath`) with the thread's token, as for its
 *    own connection. The control plane accepts that upgrade only with the
 *    thread's token, and only for an identifier it minted for that thread
 *    and is still waiting for; each is accepted once, and forgotten if the
 *    supervisor has not dialled within a few seconds. A supervisor that
 *    cannot open the stream answers `desktop_stream_failed` instead.
 * 5. The control plane sends the viewer `desktop_ready`, and from then on
 *    relays the VNC protocol (RFB, RFC 6143) both ways in binary frames:
 *    the sandbox's bytes to the viewer as they are, and the viewer's
 *    checked message by message (see "Control" below). After
 *    `desktop_ready` the control plane sends the viewer only binary frames,
 *    since a VNC client reads everything on its socket as VNC data.
 *
 * The viewer may also send text frames once `desktop_ready` has arrived:
 * `authenticate` with each refreshed token (which must name the same user;
 * the connection closes with `accessTokenExpired` when the newest expires),
 * and `take_desktop_control` and `release_desktop_control`. A binary frame
 * before `desktop_ready` closes the connection with `notAuthenticated`.
 *
 * When the sandbox's side of the stream ends (the sandbox stopping, or its
 * desktop restarting), the viewer's connection is closed with
 * `closeCodes.desktopStreamEnded`, and the viewer may open a new one.
 *
 * Control. Every viewer opens watching. The control plane forwards
 * keyboard, pointer, clipboard and screen-size messages only from the one
 * viewer that holds control of the thread's desktop, drops them from every
 * other, and closes the connection of a viewer that sends anything it does
 * not recognise. `take_desktop_control` makes the viewer that sends it the
 * holder, taking control from any other; `release_desktop_control`, or the
 * holder's connection closing, gives control back to the agent. The
 * thread's clients are told who holds it with `desktop_control_status` on
 * their own connections, and the supervisor with `desktop_control`, after
 * every welcome and whenever it changes. While the user holds control, the
 * agent's computer tool refuses to use the mouse and keyboard. That is a
 * courtesy between user and agent, not a security boundary: the agent owns
 * the desktop's display and can still drive it by other means.
 *
 * The supervisor says whether its sandbox has a desktop with
 * `desktop_availability`, after every welcome and whenever it changes.
 */

/** 16 random bytes in lowercase hexadecimal, minted by the control plane. */
export const desktopStreamIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** Names one viewer's connection, so the page can tell whether it is the one in control. */
export const desktopViewerIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

const explanationSchema = z.string().min(1).max(maximumErrorMessageLength);

/** Who may use the desktop's mouse and keyboard: the agent, or the user (through one viewer). */
export const desktopControlHolderSchema = z.enum(["agent", "user"]);

// --- Control plane and supervisor, on the supervisor's connection ---------

/** Asks the supervisor to open the desktop stream with this identifier (step 3). */
export const openDesktopStreamSchema = z.strictObject({
  type: z.literal("open_desktop_stream"),
  streamId: desktopStreamIdSchema,
});

/** Who holds the desktop's input now; the supervisor tells the agent's computer tool. */
export const desktopControlSchema = z.strictObject({
  type: z.literal("desktop_control"),
  holder: desktopControlHolderSchema,
});

/**
 * Whether the sandbox's desktop can be streamed: `running`; `starting`
 * (or starting again after it ended), so a viewer should try again
 * shortly; or `none`, a sandbox without a desktop. Unless it is running,
 * `explanation` says why, for the user.
 */
export const desktopAvailabilitySchema = z.strictObject({
  type: z.literal("desktop_availability"),
  status: z.enum(["running", "starting", "none"]),
  explanation: explanationSchema.optional(),
});

/** The supervisor could not open the stream it was asked for, and says why. */
export const desktopStreamFailedSchema = z.strictObject({
  type: z.literal("desktop_stream_failed"),
  streamId: desktopStreamIdSchema,
  reason: explanationSchema,
});

export const controlPlaneDesktopMessageSchema = z.discriminatedUnion("type", [
  openDesktopStreamSchema,
  desktopControlSchema,
]);

export const supervisorDesktopMessageSchema = z.discriminatedUnion("type", [
  desktopAvailabilitySchema,
  desktopStreamFailedSchema,
]);

// --- A viewer and the control plane, on the viewer's connection ----------

/** The viewer's connection is spliced to the sandbox's desktop; VNC data follows (step 5). */
export const desktopReadySchema = z.strictObject({
  type: z.literal("desktop_ready"),
  viewerId: desktopViewerIdSchema,
});

/**
 * Why a viewer cannot be shown the desktop now:
 * - `sandbox_not_running`: the thread's sandbox is stopped (or starting,
 *   stopping, failed); the viewer may offer to wake it.
 * - `sandbox_not_connected`: it runs, but its supervisor is not connected
 *   to this control plane yet; try again shortly.
 * - `no_desktop`: the sandbox has no desktop, as the supervisor reports;
 *   trying again will not help until the sandbox changes.
 * - `desktop_starting`: the sandbox's desktop is starting; try again
 *   shortly.
 * - `too_many_viewers`: the thread has as many viewers as it may.
 * - `stream_not_opened`: the sandbox did not open the stream in time, or
 *   said it could not; try again shortly.
 */
export const desktopUnavailableReasonSchema = z.enum([
  "sandbox_not_running",
  "sandbox_not_connected",
  "no_desktop",
  "desktop_starting",
  "too_many_viewers",
  "stream_not_opened",
]);

/** Sent instead of `desktop_ready`, just before the connection closes with `desktopUnavailable`. */
export const desktopUnavailableSchema = z.strictObject({
  type: z.literal("desktop_unavailable"),
  reason: desktopUnavailableReasonSchema,
  explanation: explanationSchema,
});

export const controlPlaneToDesktopViewerMessageSchema = z.discriminatedUnion("type", [
  desktopReadySchema,
  desktopUnavailableSchema,
]);

export const takeDesktopControlSchema = z.strictObject({
  type: z.literal("take_desktop_control"),
});

export const releaseDesktopControlSchema = z.strictObject({
  type: z.literal("release_desktop_control"),
});

/** The text frames a viewer may send; everything else it sends is VNC data, in binary frames. */
export const desktopViewerToControlPlaneMessageSchema = z.discriminatedUnion("type", [
  authenticateMessageSchema,
  takeDesktopControlSchema,
  releaseDesktopControlSchema,
]);

// --- The control plane and a thread's clients, on their own connections ---

/**
 * Which of the thread's desktop viewers holds control, or null when the
 * agent does. Sent to every client of the thread after its replay and
 * whenever it changes; a viewer compares it with its own `viewerId`.
 */
export const desktopControlStatusSchema = z.strictObject({
  type: z.literal("desktop_control_status"),
  controllingViewerId: desktopViewerIdSchema.nullable(),
});

export type DesktopControlHolder = z.infer<typeof desktopControlHolderSchema>;
export type OpenDesktopStream = z.infer<typeof openDesktopStreamSchema>;
export type DesktopControl = z.infer<typeof desktopControlSchema>;
export type DesktopAvailability = z.infer<typeof desktopAvailabilitySchema>;
export type DesktopStreamFailed = z.infer<typeof desktopStreamFailedSchema>;
export type ControlPlaneDesktopMessage = z.infer<typeof controlPlaneDesktopMessageSchema>;
export type SupervisorDesktopMessage = z.infer<typeof supervisorDesktopMessageSchema>;
export type DesktopReady = z.infer<typeof desktopReadySchema>;
export type DesktopUnavailableReason = z.infer<typeof desktopUnavailableReasonSchema>;
export type DesktopUnavailable = z.infer<typeof desktopUnavailableSchema>;
export type ControlPlaneToDesktopViewerMessage = z.infer<
  typeof controlPlaneToDesktopViewerMessageSchema
>;
export type DesktopViewerToControlPlaneMessage = z.infer<
  typeof desktopViewerToControlPlaneMessageSchema
>;
export type DesktopControlStatus = z.infer<typeof desktopControlStatusSchema>;

export function parseControlPlaneToDesktopViewerMessage(
  frameText: string,
): ParseResult<ControlPlaneToDesktopViewerMessage> {
  return parseFrame(controlPlaneToDesktopViewerMessageSchema, frameText);
}

export function parseDesktopViewerToControlPlaneMessage(
  frameText: string,
): ParseResult<DesktopViewerToControlPlaneMessage> {
  return parseFrame(desktopViewerToControlPlaneMessageSchema, frameText);
}
