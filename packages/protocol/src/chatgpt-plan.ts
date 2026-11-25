import { z } from "zod";
import { maximumModelIdLength, providerAccessSchema } from "./model-access.js";

/**
 * A user's ChatGPT plan, connected through OpenAI's "Sign in with ChatGPT"
 * programme so that their threads' OpenAI requests run on the plan rather
 * than on an API key: https://developers.openai.com/siwc
 *
 * The programme's sign-in ends by sending the browser to an address on
 * `127.0.0.1`, the machine the browser runs on, which a control plane
 * elsewhere cannot receive. So the user starts the sign-in here, approves
 * it on OpenAI's page, and hands Barrack back the address their browser
 * ended on (which fails to load, as expected), and the control plane
 * finishes the sign-in itself. It keeps the plan's tokens, sealed, and
 * nothing of them ever reaches a sandbox or a client.
 *
 * An installation offers it only when its operator turns it on, since the
 * programme's terms ask that tokens be kept under the account holder's own
 * control (see the deployment guide).
 *
 * - `GET /api/chatgpt-plan`: whether it is offered, whether the user's plan
 *   is connected, and which of their OpenAI access their threads use
 *   (`ChatGptPlanStatus`).
 * - `POST /api/chatgpt-plan/sign-in` with `{ "allowsBackgroundUse": true }`:
 *   begins a sign-in, answering the address of OpenAI's page to open
 *   (`ChatGptPlanSignInStart`); 409 `chatgpt_plan_unavailable` where it is
 *   turned off.
 * - `POST /api/chatgpt-plan/sign-in/completion` with `{ "finalAddress" }`:
 *   finishes it with the address the browser ended on, answering the new
 *   status; 400 `chatgpt_sign_in_failed`, saying what went wrong and what
 *   to do, for an address that is not one, belongs to no sign-in of the
 *   user's under way, was used already, came too late, or that OpenAI
 *   refused.
 * - `DELETE /api/chatgpt-plan`: revokes the sign-in at OpenAI and forgets
 *   it (`ChatGptPlanDisconnection`); 404 when there is none.
 * - `PUT /api/chatgpt-plan/openai-access` with `{ "access" }`: whether the
 *   user's threads spend their OpenAI API key or their ChatGPT plan on
 *   OpenAI models, from each thread's next request; 409
 *   `chatgpt_plan_not_connected` for the plan before it is connected.
 * - `GET /api/chatgpt-plan/models`: the models the plan offers that the
 *   agent can run (`ChatGptPlanModelList`); 409 `chatgpt_plan_not_connected`
 *   without a connected plan.
 */

export const chatGptPlanApiPath = "/api/chatgpt-plan";
export const chatGptPlanSignInApiPath = `${chatGptPlanApiPath}/sign-in`;
export const chatGptPlanSignInCompletionApiPath = `${chatGptPlanSignInApiPath}/completion`;
export const chatGptPlanOpenAiAccessApiPath = `${chatGptPlanApiPath}/openai-access`;
export const chatGptPlanModelsApiPath = `${chatGptPlanApiPath}/models`;

/** Where a user sees and manages what Barrack's use of their plan has spent. */
export const chatGptUsageSettingsUrl = "https://chatgpt.com/settings/usage";

/**
 * Why a plan connected before is no longer:
 * - `sign_in_expired`: OpenAI refused to renew the sign-in (it expired,
 *   was revoked in ChatGPT's settings, or was used elsewhere), so the
 *   control plane forgot it.
 */
export const chatGptPlanLossReasonSchema = z.enum(["sign_in_expired"]);

export type ChatGptPlanLossReason = z.infer<typeof chatGptPlanLossReasonSchema>;

export const chatGptPlanStatusSchema = z.strictObject({
  /** `turned_off` unless the installation's operator turned the plan on. */
  availability: z.enum(["available", "turned_off"]),
  /** The connected plan, or null. */
  connection: z
    .strictObject({
      connectedAt: z.iso.datetime(),
      /** The ChatGPT account's email address, when OpenAI says it is verified. */
      accountEmail: z.string().max(320).nullable(),
    })
    .nullable(),
  /** Set when a plan connected before was lost, until it is connected again. */
  loss: z.strictObject({ reason: chatGptPlanLossReasonSchema, at: z.iso.datetime() }).nullable(),
  /** What the user's threads spend on OpenAI models. */
  openAiAccess: providerAccessSchema,
});

export type ChatGptPlanStatus = z.infer<typeof chatGptPlanStatusSchema>;

/**
 * The programme's terms ask for express consent before a plan is used in
 * the background, as a thread's agent does while its user is away; the
 * sign-in does not begin without it.
 */
export const startChatGptPlanSignInRequestSchema = z.strictObject({
  allowsBackgroundUse: z.literal(true),
});

export const chatGptPlanSignInStartSchema = z.strictObject({
  /** OpenAI's page, to open in a new tab. */
  authorizationUrl: z.url({ protocol: /^https?$/ }),
  /** After this the address the browser ends on is no longer accepted. */
  expiresAt: z.iso.datetime(),
});

export type ChatGptPlanSignInStart = z.infer<typeof chatGptPlanSignInStartSchema>;

/** Longer than any address the programme ends on; what is pasted is read whole, with spaces trimmed. */
export const maximumFinalAddressLength = 8192;

export const completeChatGptPlanSignInRequestSchema = z.strictObject({
  finalAddress: z.string().max(maximumFinalAddressLength),
});

export const chatGptPlanDisconnectionSchema = z.strictObject({
  status: chatGptPlanStatusSchema,
  /**
   * `revoked`: OpenAI confirmed the sign-in is revoked. `not_confirmed`:
   * OpenAI could not be reached, so the sign-in was forgotten here but may
   * still be listed in ChatGPT's settings, where it can be removed.
   */
  revocation: z.enum(["revoked", "not_confirmed"]),
});

export type ChatGptPlanDisconnection = z.infer<typeof chatGptPlanDisconnectionSchema>;

export const changeOpenAiAccessRequestSchema = z.strictObject({ access: providerAccessSchema });

/** A model the plan offers, as OpenAI names it. */
export const chatGptPlanModelSchema = z.strictObject({
  modelId: z.string().min(1).max(maximumModelIdLength),
  name: z.string().min(1).max(256),
});

export const chatGptPlanModelListSchema = z.strictObject({
  models: z.array(chatGptPlanModelSchema),
});

export type ChatGptPlanModel = z.infer<typeof chatGptPlanModelSchema>;
export type ChatGptPlanModelList = z.infer<typeof chatGptPlanModelListSchema>;
