import { describe, expect, it } from "vitest";
import { type PageWindow, takeSignInReturn } from "./sign-in-link";

/** A page at `href` whose history records each address it is replaced with. */
function pageAt(href: string): PageWindow & { replacedWith: string[] } {
  const replacedWith: string[] = [];
  const page = {
    location: { href },
    history: {
      state: null,
      replaceState(_state: unknown, _unused: string, url: string) {
        replacedWith.push(url);
        page.location.href = new URL(url, href).href;
      },
    },
    replacedWith,
  };
  return page;
}

describe("the address a sign-in link comes back to", () => {
  it("brings the auth code, which is taken out of the address so a reload cannot replay it", () => {
    const page = pageAt("https://barrack.example.com/?code=6b1c2a77-9d8e-4f6a-8c1b-2e3d4f5a6b7c");

    const signInReturn = takeSignInReturn(page);
    const afterReload = takeSignInReturn(page);

    expect(signInReturn).toEqual({
      kind: "link",
      authCode: "6b1c2a77-9d8e-4f6a-8c1b-2e3d4f5a6b7c",
    });
    expect(page.replacedWith).toEqual(["/"]);
    expect(afterReload).toEqual({ kind: "none" });
  });

  it("says why Supabase refused a link that expired or was used, in the query and the fragment, and is cleaned too", () => {
    const description = "Email+link+is+invalid+or+has+expired";
    const members = `error=access_denied&error_code=otp_expired&error_description=${description}`;
    const page = pageAt(`https://barrack.example.com/?${members}#${members}&sb=`);

    expect(takeSignInReturn(page)).toEqual({ kind: "refused", errorCode: "otp_expired" });
    expect(page.replacedWith).toEqual(["/"]);
  });

  it("reads a refusal carried in the fragment alone", () => {
    const page = pageAt(
      "https://barrack.example.com/#error=access_denied&error_code=otp_expired&error_description=x&sb=",
    );

    expect(takeSignInReturn(page)).toEqual({ kind: "refused", errorCode: "otp_expired" });
    expect(page.replacedWith).toEqual(["/"]);
  });

  it("keeps the rest of the address", () => {
    const page = pageAt("https://barrack.example.com/?thread=thread-1&code=abc");

    expect(takeSignInReturn(page)).toEqual({ kind: "link", authCode: "abc" });
    expect(page.replacedWith).toEqual(["/?thread=thread-1"]);
  });

  it.each([
    [
      "GitHub's callback, whose code is GitHub's",
      "https://barrack.example.com/github/callback?code=abc&state=xyz",
    ],
    ["the settings page", "https://barrack.example.com/?page=settings"],
    ["a thread", "https://barrack.example.com/?thread=thread-1#top"],
  ])("is not %s, which is left as it is", (_case, href) => {
    const page = pageAt(href);

    expect(takeSignInReturn(page)).toEqual({ kind: "none" });
    expect(page.replacedWith).toEqual([]);
  });

  it("keeps no description the address carried, since anyone can write one into a link", () => {
    const page = pageAt(
      "https://barrack.example.com/?error=access_denied&error_description=Call+this+number",
    );

    expect(takeSignInReturn(page)).toEqual({ kind: "refused", errorCode: undefined });
  });
});
