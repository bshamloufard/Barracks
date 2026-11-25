import { describe, expect, it } from "vitest";
import { chatGptPlanPiCompat } from "../../../apps/sandbox-supervisor/src/pi/chatgpt-plan-compat.js";
import {
  type AgentRequest,
  buildChatGptPlanRequestsThroughProxy,
  buildChatGptPlanRequestsToOpenAi,
} from "./agent-requests.js";

/**
 * On a ChatGPT plan the sandbox's Pi sends OpenAI's requests to the model
 * proxy, which relays them as they come; the proxy checks them against what
 * Pi sends OpenAI's "Sign in with ChatGPT" programme itself (the list's
 * `chatgptPlan`). Pi shapes them for the programme by itself only at
 * OpenAI's own address, so the supervisor gives it flags that do the same
 * at the proxy's (`chatGptPlanPiCompat`). This test is what lets the proxy
 * strip nothing: it fails unless those flags make every request the pinned
 * Pi sends, for every OpenAI model it lists at every thinking level and
 * cache retention, byte for byte what it sends the programme, and so
 * catches an upgrade of Pi that leaves out something more on its own
 * sign-in, or some other way of telling the two apart.
 */

/** Each request's body, by what varied, in the order Pi was made to send them. */
async function collectBodies(
  build: (onRequest: (request: AgentRequest) => void) => Promise<void>,
): Promise<Map<string, { path: string; body: string }>> {
  const bodies = new Map<string, { path: string; body: string }>();
  await build((request) => {
    bodies.set(`${request.modelId}: ${request.variant}`, {
      path: `${request.method} ${request.path}`,
      body: request.body,
    });
  });
  return bodies;
}

describe("the agent's requests on a ChatGPT plan", () => {
  it("are, through the proxy with the supervisor's flags, exactly what the agent sends the programme itself", {
    timeout: 180_000,
  }, async () => {
    const toOpenAi = await collectBodies(buildChatGptPlanRequestsToOpenAi);
    const throughProxy = await collectBodies((onRequest) =>
      buildChatGptPlanRequestsThroughProxy(chatGptPlanPiCompat, onRequest),
    );

    expect(toOpenAi.size).toBeGreaterThan(4_000);
    expect([...throughProxy.keys()]).toEqual([...toOpenAi.keys()]);
    const differing = [...toOpenAi].filter(
      ([variant, sent]) =>
        throughProxy.get(variant)?.body !== sent.body ||
        throughProxy.get(variant)?.path !== sent.path,
    );
    expect(differing.map(([variant]) => variant)).toEqual([]);
  });

  it("differ without those flags, so the comparison above can fail", {
    timeout: 180_000,
  }, async () => {
    const toOpenAi = await collectBodies(buildChatGptPlanRequestsToOpenAi);
    const throughProxy = await collectBodies((onRequest) =>
      buildChatGptPlanRequestsThroughProxy({}, onRequest),
    );

    const same = [...toOpenAi].filter(
      ([variant, sent]) => throughProxy.get(variant)?.body === sent.body,
    );
    expect(same.length).toBeLessThan(toOpenAi.size);
  });
});
