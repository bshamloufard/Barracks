import { describe, expect, it } from "vitest";
import { readFinalAddress } from "./final-address.js";

const finalAddress =
  "http://127.0.0.1:1455/auth/callback?code=the-code&scope=openid+chatgpt.tokens.use.direct&state=the-state&client_id=oaiapp-1";

describe("reading the address a browser ended on after a ChatGPT sign-in", () => {
  it("takes the whole address, with its code, state, issued client and scopes", () => {
    expect(readFinalAddress(finalAddress)).toEqual({
      kind: "approved",
      code: "the-code",
      state: "the-state",
      clientId: "oaiapp-1",
      scopes: ["openid", "chatgpt.tokens.use.direct"],
    });
  });

  it.each([
    ["with spaces and a line break around it", `  ${finalAddress}\n`],
    ["in quotation marks", `"${finalAddress}"`],
    ["in angle brackets", `<${finalAddress}>`],
    ["without its http://", finalAddress.slice("http://".length)],
    ["as only the part from ? on", finalAddress.slice(finalAddress.indexOf("?"))],
    ["as only the part after ?", finalAddress.slice(finalAddress.indexOf("?") + 1)],
    ["on another port", finalAddress.replace(":1455", ":54321")],
  ])("takes it %s", (_how, pasted) => {
    expect(readFinalAddress(pasted)).toMatchObject({ kind: "approved", code: "the-code" });
  });

  it.each([
    ["nothing", "   ", "empty"],
    ["words", "I approved it", "not_an_address"],
    [
      "OpenAI's own page, copied before approving",
      "https://auth.openai.com/api/accounts/authorize?client_id=x&code_challenge=y&state=z",
      "authorization_page",
    ],
    ["another site", "https://example.com/?code=a&state=b", "elsewhere"],
    [
      "localhost, which the programme never sends to",
      "http://localhost:1455/auth/callback?code=a&state=b",
      "elsewhere",
    ],
    ["the callback on another path", "http://127.0.0.1:1455/callback?code=a&state=b", "elsewhere"],
    ["the callback without its code", "http://127.0.0.1:1455/auth/callback?state=b", "cut_short"],
    ["the callback without its state", "http://127.0.0.1:1455/auth/callback?code=a", "cut_short"],
    ["the callback cut at ?", "http://127.0.0.1:1455/auth/callback?", "cut_short"],
  ])("names what is wrong with %s", (_what, pasted, problem) => {
    expect(readFinalAddress(pasted)).toEqual({ kind: "unreadable", problem });
  });

  it("tells a declined sign-in from an error OpenAI ended it with, keeping the state to check", () => {
    expect(
      readFinalAddress("http://127.0.0.1:1455/auth/callback?error=access_denied&state=s1"),
    ).toEqual({ kind: "declined", state: "s1" });
    expect(
      readFinalAddress(
        "http://127.0.0.1:1455/auth/callback?error=3p_delegated_access_policy_denied&error_description=Blocked&state=s2",
      ),
    ).toEqual({
      kind: "refused_by_openai",
      error: "3p_delegated_access_policy_denied",
      description: "Blocked",
      state: "s2",
    });
  });
});
