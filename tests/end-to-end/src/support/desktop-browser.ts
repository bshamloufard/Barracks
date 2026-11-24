// The functions passed to the browser run in its pages, where the DOM is.
/// <reference lib="dom" />
import { createRequire } from "node:module";

/**
 * A real browser on the web client, for the desktop's acceptance test.
 * Playwright is not one of the repository's dependencies: the test uses the
 * one installed on the machine it runs on (resolved through `NODE_PATH`,
 * with its own Chromium), and says so when there is none.
 *
 * Only the few Playwright members the test uses are typed here.
 */
export type BrowserPage = {
  goto(url: string): Promise<unknown>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<Result, Argument>(
    script: (argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result>;
  getByTestId(testId: string): BrowserLocator;
  getByRole(role: "button", options: { name: string }): BrowserLocator;
  mouse: { click(x: number, y: number): Promise<void> };
  keyboard: {
    type(text: string, options?: { delay?: number }): Promise<void>;
    press(key: string): Promise<void>;
  };
  waitForFunction<Argument>(
    script: (argument: Argument) => boolean,
    argument: Argument,
    options: { timeout: number },
  ): Promise<unknown>;
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): void;
};

export type BrowserLocator = {
  click(): Promise<void>;
  textContent(): Promise<string | null>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  waitFor(options: { timeout: number }): Promise<void>;
};

type BrowserContext = {
  newPage(): Promise<BrowserPage>;
  addInitScript<Argument>(script: (argument: Argument) => void, argument: Argument): Promise<void>;
  close(): Promise<void>;
};

type Browser = {
  newContext(options: {
    viewport: { width: number; height: number };
    hasTouch?: boolean;
  }): Promise<BrowserContext>;
  close(): Promise<void>;
};

type Playwright = { chromium: { launch(options: { args: string[] }): Promise<Browser> } };

/** Why the browser test cannot run here, or undefined if it can. */
export function describeWhyBrowserCannotRun(): string | undefined {
  try {
    loadPlaywright();
    return undefined;
  } catch {
    return "Playwright, with its Chromium, is not installed where Node can find it (NODE_PATH)";
  }
}

function loadPlaywright(): Playwright {
  return createRequire(import.meta.url)("playwright") as Playwright;
}

/**
 * A browser whose pages are signed in as the user the access token is for,
 * through supabase-js's own stored session, as a page that signed in with
 * an email code would have it. `origin` is the web client's, which is
 * treated as secure (noVNC wants a secure context; production is HTTPS).
 */
export async function launchSignedInBrowser(settings: {
  origin: string;
  supabaseUrl: string;
  accessToken: string;
}): Promise<{
  openPage(viewport: { width: number; height: number }): Promise<BrowserPage>;
  close(): Promise<void>;
}> {
  const browser = await loadPlaywright().chromium.launch({
    args: [`--unsafely-treat-insecure-origin-as-secure=${settings.origin}`],
  });
  const storageKey = `sb-${new URL(settings.supabaseUrl).hostname.split(".")[0]}-auth-token`;
  const session = describeStoredSession(settings.accessToken);
  const contexts: BrowserContext[] = [];
  return {
    async openPage(viewport) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600 });
      contexts.push(context);
      await context.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
        key: storageKey,
        value: JSON.stringify(session),
      });
      return context.newPage();
    },
    async close() {
      await Promise.all(contexts.map((context) => context.close()));
      await browser.close();
    },
  };
}

/** The session supabase-js keeps in local storage, built around the token. */
function describeStoredSession(accessToken: string) {
  const [, payload = ""] = accessToken.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    sub: string;
    email?: string;
    exp: number;
  };
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: claims.exp - Math.floor(Date.now() / 1000),
    expires_at: claims.exp,
    refresh_token: "not-used-by-this-test",
    user: {
      id: claims.sub,
      aud: "authenticated",
      role: "authenticated",
      email: claims.email,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  };
}
