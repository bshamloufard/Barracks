import { type ApiErrorCode, apiErrorResponseSchema } from "@barrack/protocol";

type AnswerSchema<Answer> = {
  safeParse(value: unknown): { success: true; data: Answer } | { success: false };
};

/**
 * The control plane refused a request, saying why: `explanation` is its own
 * message, written for the user, and the error's message says what was
 * being attempted besides.
 */
export class ApiRefusal extends Error {
  constructor(
    readonly code: ApiErrorCode | undefined,
    readonly explanation: string,
    attempt: string,
  ) {
    super(`Could not ${attempt}: ${explanation}`);
    this.name = "ApiRefusal";
  }
}

/**
 * The answer, checked against its schema; throws `ApiRefusal` for a
 * refusal, and an error saying the page is out of date for an answer it
 * does not understand.
 */
export async function readApiAnswer<Answer>(
  response: Response,
  schema: AnswerSchema<Answer>,
  attempt: string,
): Promise<Answer> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = apiErrorResponseSchema.safeParse(body);
    throw apiError.success
      ? new ApiRefusal(apiError.data.error.code, apiError.data.error.message, attempt)
      : new ApiRefusal(undefined, `HTTP ${response.status}`, attempt);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Could not ${attempt}: the control plane answered in a way this page does not understand. Reload the page.`,
    );
  }
  return parsed.data;
}
