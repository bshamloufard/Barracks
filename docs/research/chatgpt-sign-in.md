# ChatGPT plan sign-in for Barrack (Milestone 4): research notes

> **What this is.** Research notes from Milestone 4, written on 2026-11-24 before a route was chosen, and kept as the basis for building it. They are a record, not a specification: the owner has since chosen the "Sign in with ChatGPT" programme alone (see the decision log), so the parts about the device-code route describe something Barrack does not build. Paths beginning `scratchpad/` point at working copies that were not kept. The notes predate the model proxy, so section 5 treats relaying model traffic as future work. Read OpenAI's current pages again before relying on any quotation here.

Researched 2026-11-24.

**Sources**

- **Pi.** Source clone `scratchpad/pi-src/repo` at main `f8149d1` (2026-11-24). Its auth code matches the published `@earendil-works/pi-ai@1.6.0` dist in `scratchpad/pi-try/node_modules`, which I checked by grep for the constants and error strings. `npm view` still reports 1.6.0 as the latest version. The `[Unreleased]` changelog has no auth changes.
- **Codex.** Sparse shallow clone `scratchpad/codex-src/repo` of `openai/codex` at main `abc92e6` (2026-11-24). The npm `@openai/codex` latest is 0.172.0.
- **Web pages.** Fetched on 2026-11-24 unless a date is shown.

**Tags**

- **[src]**: read in source.
- **[doc]**: official OpenAI page.
- **[ran]**: observed by running code.
- **[report]**: third-party or social-media statement. A report is not policy.
- **[inf]**: inference.

No OpenAI endpoint that needs credentials was called. No sign-in was attempted.

---

## 0. One-paragraph answer

There are two technically distinct ChatGPT-plan paths. All three routes in the plan reduce to one of them.

**Path A: the Codex first-party OAuth client.**

- Client id `app_EMoamEEZ73f0CkXaXp7hrann`.
- Tokens come from `auth.openai.com/oauth/token`.
- Inference goes to `chatgpt.com/backend-api/codex/responses`.
- It is the **only** path with a device-code flow.
- Routes 1 (Pi `openai-codex`) and 2 (Codex app-server `chatgptDeviceCode`) both use it.

**Path B: "Sign in with ChatGPT" (SIWC) plan usage.**

- Uses per-user dynamic client registration (`dynamic_agent_client`) and `ext_agent_host_id`.
- Tokens come from `auth.openai.com/api/accounts/oauth/token`.
- Inference goes to `api.openai.com/v1/responses`.
- It is the officially documented, terms-governed path for third-party and open-source apps. Pi is a listed open-source partner.
- It has **no device-code variant**: the redirect is loopback-only. For remote hosts OpenAI documents "complete OAuth locally and transfer the credentials". It is route 3, and Pi implements it as the `openai` provider.

OpenAI's own Codex docs now say app-server (Path A) auth in third-party apps may continue but should migrate to SIWC. They also say Path A auth "has never been permitted for commercial or hosted services".

---

## 1. Route 1: Pi's own ChatGPT sign-in

### 1.1 `openai-codex` (Path A). File `packages/ai/src/auth/oauth/openai-codex.ts` [src]

Constants (lines 22–35):

```ts
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI's client id (OpenAI's own app)
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEVICE_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const SCOPE = "openid profile email offline_access";
```

**Whose client id it is.** Codex defines the same constant at `codex-rs/login/src/auth/manager.rs:1897`: `pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";`. Codex lets it be overridden with `CODEX_APP_SERVER_LOGIN_CLIENT_ID`. Pi therefore signs in **as the Codex CLI client**. For browser login it sends `originator=pi`, or `LoginOptions.agentName`.

**Device-code flow, end to end** (`loginOpenAICodexDeviceCode`, lines 341–357; poller `device-code.ts`):

1. `POST …/deviceauth/usercode` with body `{"client_id": CLIENT_ID}`. The response is `{device_auth_id, user_code, interval}`; `interval` may be a string.
   - A **404** here throws `"OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL."`. This means the server does not offer device codes. It is **not** the per-account ChatGPT setting.
   - Any other non-2xx status throws `OpenAI Codex device code request failed with status N: body`.
2. `interaction.notify({type:"device_code", userCode, verificationUri:"https://auth.openai.com/codex/device", intervalSeconds, expiresInSeconds:900})`.
3. Pi polls `POST …/deviceauth/token` with body `{device_auth_id, user_code}`.
   - Polling starts immediately, then repeats every `interval` seconds (minimum 1 s; default 5 s if the field is absent).
   - **403 or 404 means pending.** The body codes `deviceauth_authorization_pending` (pending) and `slow_down` (add 5 s) are also handled.
   - Any other status fails with `OpenAI Codex device auth failed with status N: body`.
   - After 15 minutes it fails with `Device flow timed out`, or with the clock-drift message if a `slow_down` was seen.
4. Success returns `{authorization_code, code_verifier}`. Pi exchanges these at `/oauth/token`: `grant_type=authorization_code, client_id, code, code_verifier, redirect_uri=https://auth.openai.com/deviceauth/callback`.
5. The token response must contain `access_token`, `refresh_token` and `expires_in`.
   - The credential is `{type:"oauth", access, refresh, expires: now+expires_in*1000, accountId}`.
   - `accountId` is taken from the JWT claim `https://api.openai.com/auth.chatgpt_account_id`. Login throws if the claim is missing.

Codex's own implementation (`codex-rs/login/src/device_code_auth.rs`) is the same protocol, with the same 403/404 → keep polling rule and the same 15-minute limit. It prints: "Open this link in your browser and sign in … Enter this one-time code (expires in 15 minutes) … Continue only if you started this login in Codex. If a website or another person gave you this code, cancel."

**What the user sees:**

1. A link, `auth.openai.com/codex/device`, and a code such as `ABCD-1234`.
2. They open the link on any device and sign in to ChatGPT. This can include MFA or a phone-verification gate.
3. They enter the code and approve.
4. Barrack's poll completes.

**"Device code login disabled in security settings"**

- [doc] learn.chatgpt.com/docs/auth "Login on headless devices" says: "Enable device code login in your ChatGPT security settings (personal account) or ChatGPT workspace permissions (workspace admin)."
- [report] everpod.ai (updated 2026-11-22) gives the switch name: Settings → Security and login → "Enable device code sign-in for Codex, Excel, PowerPoint, and Word". It also gives the message wording: "Enable device code sign-in for Codex, Excel, PowerPoint, and Word in ChatGPT security settings, then run "codex login --device-auth" again." The older wording was "Enable device code authorization for Codex in ChatGPT security settings".
- **Where the refusal shows up.** Neither Codex's nor Pi's client code contains this string, so it is not a client error. openai/codex issue #34817 (2026-07-22) describes the flow: the user enters the code in the **browser**, is redirected through sign-in, account selection and MFA, and only then sees that device-code authorization is disabled. lucaberton.com (2026-07-24) says "the code is rejected server-side and the CLI never receives a token".
- **Consequence for Barrack** [inf]. The polling client keeps getting 403/404, which it treats as pending, until the 15-minute timeout. Barrack cannot detect this case through the API. The UI should therefore:
  - show the hint up front, next to the code ("If the page says device-code sign-in is disabled, turn on Settings → Security and login → Enable device code sign-in… then start again");
  - repeat the hint on timeout;
  - offer a "Cancel / start again" action, because the code must be regenerated after the setting is enabled.
- Workspace accounts need an admin. Codex issues #9282, #9418 and #9253 cover this: the workspace setting is under Workspace settings → Permissions & roles → Codex Local → "Enable device code authentication".

**Refresh.** `refreshAccessToken` sends `grant_type=refresh_token, refresh_token, client_id` to `/oauth/token`. A new refresh token is stored each time.

**Access-token lifetime for this client** [report]. The JWT `exp` is about 10 days, and `expires_in` is 864000 (gubasso/codex-session docs, empirical 2026-05-26). Codex refreshes when the JWT is within 5 minutes of expiry (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`), or when `last_refresh` is more than 8 days old (`TOKEN_REFRESH_INTERVAL = 8`) (`manager.rs:232–233, 3695–3711`).

### 1.2 `openai` "Sign in with ChatGPT" (Path B). File `packages/ai/src/auth/oauth/openai-chatgpt.ts` [src]

- **Registration.** It always registers a new client with `client_id=dynamic_agent_client`. It does not reuse the issued client id on re-login.
- **Authorize request** to `https://auth.openai.com/api/accounts/authorize`, with:
  - `agent_name_hint` (default "Pi", overridable with `LoginOptions.agentName`)
  - `ext_agent_host_id=urn:uuid:<deviceId>`; this requires `LoginOptions.getDeviceId()`, which must return a UUID
  - `resource=https://api.openai.com/v1`
  - `scope="openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"`
  - PKCE, `state` and `nonce`
- **Redirect URI** is fixed at `http://127.0.0.1:1455/auth/callback`. Pi **binds port 1455 itself** and fails with `Port 1455 is in use…` when the port is taken. It also races a `manual_code` prompt that accepts the pasted final redirect URL.
- **Token exchange** goes to `https://auth.openai.com/api/accounts/oauth/token` with the issued `client_id` and `resource`.
  - Pi requires an `id_token` but **does not validate it**.
  - It requires `chatgpt.tokens.use.direct` among the granted scopes.
- **Credential:** `{type:"oauth", access, refresh, expires: now+expires_in*1000−3 min, clientId, scopes[]}`.
- **No device-code method.**

### 1.3 Programmatic entry points (no terminal) [src]

**(a) pi-ai, no Pi runtime.** Usable from the control plane or the supervisor:

```ts
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
const oauth = openaiCodexProvider().auth.oauth!; // lazyOAuth wrapper: login/refresh/toAuth
const ac = new AbortController();
const cred = await oauth.login(
  {
    signal: ac.signal,
    prompt: async (p) =>
      p.type === "select" ? "device_code" : Promise.reject(new Error("unexpected prompt")),
    notify: (ev) => {
      if (ev.type === "device_code")
        showToUser(ev.userCode, ev.verificationUri, ev.expiresInSeconds);
    },
  },
  { agentName: "barrack" },
);
// cred = { type:"oauth", access, refresh, expires, accountId }
// later: await oauth.refresh(cred, AbortSignal.timeout(15000))
```

**(b) Pi runtime.** `ModelRuntime.create({ authPath }).login("openai-codex", "oauth", interaction, { getDeviceId })` (`packages/coding-agent/src/core/model-runtime.ts:868`). It persists the credential to that `auth.json` under the provider's lock.

**(c) What does not work.**

- `pi auth login` refuses to run without a TTY. The earlier run confirmed this.
- RPC mode has no login command.
- `pi auth print-bearer-token --provider X [--min-expiry 30m]` is non-interactive. It refreshes when needed, which helps a supervisor read the current access token.

**(d) For SIWC, do not call Pi's login from a multi-user control plane** [inf]. Three reasons, from the facts above:

- it binds the fixed port 1455, so concurrent logins collide;
- it re-registers a client every time, so it never reuses the issued `client_id` as the SIWC docs require;
- it skips ID-token validation.

Barrack should implement the SIWC authorize/exchange itself (PKCE + `state` + `nonce`, about 200 lines, documented at developers.openai.com/siwc/token-sharing-open-source/sign-in). Barrack then only gives Pi the resulting access token (§5).

### 1.4 Refresh, locking and rotation [src]

- Refresh happens in `packages/ai/src/auth/resolve.ts` `resolveStoredOAuth`. Before every request, a token with less than 5 minutes left is refreshed inside `credentials.modify(...)`, re-checked under the lock, and given a hard 15-second timeout. The refresh "ignore[s] signal" once started, so that a cancelled caller cannot discard the only valid refresh token.
- The lock is `proper-lockfile` on the resolved path of `auth.json` (`coding-agent/src/core/auth-storage.ts:61–203`). It is mkdir-based, stale after 30 s, and retried with backoff for up to 30 s.
- **Pi re-reads `auth.json` whenever the file revision changes.** `AuthStorage.readLatestData` compares `getFileRevision(path) = dev:ino:size:mtimeNs:ctimeNs` (`utils/paths.ts:80`) on every `read()`.
- [ran] `scratchpad/m4-authtest/test.mjs`:
  - Setup: one `pi --mode rpc` process, a local mock provider, and `auth.json` holding `{"mock":{"type":"api_key","key":"tok-ONE"}}`.
  - Prompt 1 sent `Authorization: Bearer tok-ONE`.
  - The file was then rewritten to `tok-TWO-longer`, and prompt 2 sent `Bearer tok-TWO-longer` **without a restart**.
- **Rotation invalidates other copies (confirmed).**
  - Codex source maps the server error `{"error":{"message":"Your refresh token has already been used to generate a new access token. Please try signing in again.","code":"refresh_token_reused"}}` to "your refresh token was already used. Please log out and sign in again." (`codex-rs/login/src/auth/util.rs:24–30`, `manager.rs:236, 1869–1882`).
  - OpenAI's CI guide [doc] (developers.openai.com/codex/auth/ci-cd-auth) says: "Do not share the same file across concurrent jobs or multiple machines" and "Reseed … if … another machine or concurrent job rotated the token first".
  - SIWC [doc] lists `refresh_token_reused` and `refresh_token_invalidated` as unusable-refresh-token errors and says "serialize refreshes for the same session so two processes do not race a rotating token".
  - Whether reuse also revokes the whole token family is unmeasured. ai-on-gke/grain says "Nobody has measured it".
- Pi's changelog shows real incidents: `invalid_grant` after Pi exited during a refresh (1.5.0, #11692), and `refresh_token_invalidated` after a cancelled refresh (1.0.3). **Never SIGKILL Pi during a refresh.** Stdin EOF lets it finish.

### 1.5 How plan exhaustion surfaces in Pi [src]

**Event shape.** All of these arrive as the final assistant `message_end` with `stopReason:"error"` and `errorMessage`, followed by `agent_end` and `agent_settled`. They are **not retried** by Pi's agent-level retry:

- `isRetryableAssistantError` in `packages/ai/src/utils/retry.ts:315` matches the non-retryable list first.
- The Codex friendly text matches no retryable pattern.
- The Codex SSE path skips its own network retry when the message contains "usage limit" (`openai-codex-responses.ts:471`).

| Route                                                  | Trigger                                                                                                                                           | `errorMessage` text Barrack sees                                                                                                                                                                                                                                           | Reset time?                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-codex`, SSE transport                          | HTTP 4xx body `{"error":{"code"/"type":"usage_limit_reached"\|"usage_not_included"\|"rate_limit_exceeded", "plan_type", "resets_at"}}` or any 429 | `You have hit your ChatGPT usage limit (plus plan). Try again in ~N min.` (`parseErrorResponse`, lines 1626–1651). It turns the absolute `resets_at` into rounded minutes.                                                                                                 | Only "~N min" in the text. The exact value is in response headers `x-codex-primary-reset-at`, `x-codex-secondary-reset-at`, `…-used-percent`, `…-window-minutes` and `x-codex-rate-limit-reached-type` (header names from `codex-rs/codex-api/src/rate_limits.rs:60–82`). These are visible to a Barrack extension through `pi.on("after_provider_response", e => e.headers)`; `onResponse` fires before the error branch (line 432). |
| `openai-codex`, WebSocket (default `transport:"auto"`) | stream event `{type:"error", error:{code, message}}` or `response.failed`                                                                         | `Codex error: <server message>`, or the server message itself. **No friendly text, no reset time.**                                                                                                                                                                        | Lost from the text. The raw event is visible to `pi.on("provider_stream_event")`. **Set `"transport":"sse"` in settings.json** so headers are available [inf].                                                                                                                                                                                                                                                                        |
| `openai` SIWC                                          | `429 {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}` or `response.failed` mid-stream                                              | `OpenAI API error (429): …subscription_sharing_usage_limit_exceeded…` + `\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage` (`openai-responses.ts:253–259`). Business variant: `subscription_sharing_workplace_individual_usage_limit_exceeded` + admin hint. | **None.** OpenAI says: "Do not assume the entire plan is empty or infer a reset time from this code alone; an app-specific limit can also apply."                                                                                                                                                                                                                                                                                     |
| SIWC transient                                         | `subscription_sharing_usage_unavailable` or `subscription_sharing_user_unavailable` (503)                                                         | retried by Pi                                                                                                                                                                                                                                                              | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| API key                                                | `insufficient_quota`                                                                                                                              | non-retryable                                                                                                                                                                                                                                                              | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Recommended classifier in the supervisor** [inf]. Match the regexes in this order: `subscription_sharing_workplace_individual_usage_limit_exceeded` → `subscription_sharing_usage_limit_exceeded` → `You have hit your ChatGPT usage limit(?: \((\w+) plan\))?\.(?: Try again in ~(\d+) min\.)?` → `/usage_limit_reached|usage_not_included|usage limit/i` → `insufficient_quota|quota exceeded|billing`.

When a match fires:

- Stop the thread in a `plan_exhausted` state with a reason.
- Keep the session, then offer **Resume** (send `continue`) or **Switch model** (`set_model` over RPC, recorded as a `model_change` entry, then resume).
- Link to `https://chatgpt.com/settings/usage`. The SIWC UI guidelines make "Manage usage" the primary action.

---

## 2. Route 2: OpenAI's Codex agent

**The real thing is `codex app-server`.**

- [doc] developers.openai.com/codex/app-server = learn.chatgpt.com/docs/app-server: "the interface Codex uses to power rich clients (for example, the Codex VS Code extension)".
- Transport: JSON-RPC-lite (no `"jsonrpc"` field) over stdio JSONL by default. WebSocket is "experimental and unsupported". There is also a Unix socket transport.
- Schemas come from `codex app-server generate-ts` or `codex app-server generate-json-schema`.
- **Codex SDK** (`@openai/codex-sdk`, Node ≥18) wraps the CLI over JSONL, and is meant "for CI/automation". There is also a Python SDK over app-server.
- `codex mcp-server` has been removed.
- The protocol is v2 (`codex-rs/app-server-protocol/src/protocol/v2/account.rs`):
  - `chatgptDeviceCode` login is a stable variant (not behind `#[experimental]`).
  - `chatgptAuthTokens` is marked `[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE` in the schema, while the docs call it "experimental".

**Device-code login API** [doc]:

```json
{ "method":"account/login/start","id":4,"params":{"type":"chatgptDeviceCode"} }
→ { "id":4,"result":{"type":"chatgptDeviceCode","loginId":"<uuid>","verificationUrl":"https://auth.openai.com/codex/device","userCode":"ABCD-1234"} }
← notify account/login/completed {loginId, success, error}; account/updated {authMode:"chatgpt", planType:"plus"}
```

Other auth methods:

- `account/login/cancel`, `account/logout`, `account/read {refreshToken}`.
- **`account/rateLimits/read`** returns `primary/secondary {usedPercent, windowDurationMins, resetsAt}`, and `account/rateLimits/updated` notifications report changes.
- Turn `error` notifications carry `codexErrorInfo: "usageLimitExceeded"`.
- Codex's own limit text includes the reset time (`codex-rs/protocol/src/error.rs:870–975`, `UsageLimitReachedError{plan_type, resets_at, …}`).
- Rate-limit visibility is **better than Pi's**.

**Credential storage** [doc] (developers.openai.com/codex/auth):

- `cli_auth_credentials_store = file | keyring | auto | ephemeral`.
- The file is `$CODEX_HOME/auth.json` (default `~/.codex`), "a plaintext file".
- Shape [src] (`codex-rs/login/src/auth/storage.rs`, `token_data.rs`): `{auth_mode, OPENAI_API_KEY, tokens:{id_token, access_token, refresh_token, account_id, oauth_provenance?, login_owner_id?}, last_refresh}`.
- Writes use compare-and-save ("Credentials changed before refresh commit."). Codex reloads from disk before refreshing and on a 401.

**Permitted use** [doc] (learn.chatgpt.com/docs/app-server, "Auth endpoints", fetched 2026-11-20): "If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT … **App-server authentication has never been permitted for commercial or hosted services.** We launched Sign in with ChatGPT to support these use cases".

App-server can also run on SIWC: [doc] siwc/token-sharing-open-source/codex-app-server sets `model_provider` to a Responses provider with `env_key="ACCESS_TOKEN"` and `supports_websockets=false`. The docs say "Your app must refresh the OAuth token … restart app-server with the renewed `ACCESS_TOKEN`, then resume the saved thread."

**Using Codex only as the sign-in mechanism, with Pi as the agent:**

- **Technically possible, by accident rather than by design.** Codex and Pi `openai-codex` use the same client id, the same token endpoint and the same backend.
- Mapping from Codex to Pi: `tokens.access_token → access`, `tokens.refresh_token → refresh`, `exp(JWT)*1000 → expires`, `tokens.account_id → accountId`.
- Pi has no importer. There is no reference to `CODEX_HOME` or `.codex/auth.json` anywhere in Pi's src.
- Both programs then hold the same rotating refresh token. Exactly one of them may keep refreshing, so Codex would have to be discarded after login.
- Net gain over calling Pi's own device-code login: none. It adds a roughly 100 MB Rust binary, a second auth store, and the same Path A terms posture. **Not recommended.**

**As a second harness.** It brings its own sandbox and approval model, its own thread store (`~/.codex/sessions`), its own event schema and its own model catalog. That is a full second integration. The plan puts other harnesses out of scope for now. Keeping the boundary clean means the supervisor's "harness" interface should not assume Pi's event names. That is not a reason to adopt it now.

---

## 3. Route 3: "Sign in with ChatGPT" (SIWC) plan usage

**Official pages** [doc]:

- developers.openai.com/siwc (quickstart)
- /siwc/token-sharing-open-source (overview, sign-in, profiles-and-sessions, models-and-inference, errors-and-recovery, preview-limitations, self-hosted-vms, token-reference, codex-app-server)
- /siwc/ui-ux-guidelines
- cookbook developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- terms openai.com/policies/sign-in-with-chatgpt-terms ("Effective: November 4, 2026")
- user help help.openai.com/en/articles/20001542 ("Using your ChatGPT plan in other apps and sites")
- partner directory learn.chatgpt.com/docs/sign-in-with-chatgpt
- DevKit github.com/openai/sign-in-with-chatgpt-devkit

**Eligibility and approval:**

- Quickstart: "Sign in with ChatGPT is currently available to selected commercial partners through a limited trial. **ChatGPT plan usage is available to all open-source partners** and selected private clients."
- Overview: "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a **paid or remotely hosted app, complete the interest form**."
- Cookbook: "available for open-source tools and personal projects that run locally. If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users."
- OpenAI_Support on community.openai.com/t/1404507 (2026-11-09), to a C# Pi port: SIWC "provides a supported integration path" for open-source clients; "If your implementation is paid or remotely hosted, please follow the access requirements".
- **No registration is needed for open-source or local use.** Dynamic registration happens at the user's first sign-in.
- The partner directory lists **Pi** among the "Open-source integrations", alongside OpenClaw, OpenCode and T3. Commercial partners listed include Amp, Conductor, Devin, Warp, Vercel and Notion.

**Flow:**

- Authorization Code + PKCE + OIDC nonce against `https://auth.openai.com/api/accounts/authorize`.
- First time: `client_id=dynamic_agent_client`, `agent_name_hint=<app name>`, `ext_agent_host_id`. The callback returns the issued `client_id` (`oaiapp_…`), which must be saved and reused.
- Later sign-ins: the issued `client_id`, `id_token_hint` and `login_hint`.
- Scopes: identity `openid profile email`; plan usage `offline_access resource.invoke chatgpt.tokens.use.direct`.
- `resource=https://api.openai.com/v1`.
- **Redirect:** "Use an HTTP loopback callback on `127.0.0.1` … only the port may vary … Do not substitute with `localhost`."
- The ID token must be validated against the JWKS: issuer, audience = issued client id, expiry and nonce.
- **Host IDs:** "Generate and persist a stable `ext_agent_host_id` for each host separately". The formats are a JWK thumbprint URI, `urn:uuid:` or `did:key`. "Your app defines what counts as one host." One issued `client_id` can be shared across hosts of the same user and workspace.
- **No device-code or browserless variant exists.** The only remote-host guidance is /self-hosted-vms: "A `127.0.0.1` callback reaches the computer running the browser, not the remote VM. Complete OAuth locally with the same tool/client … Transfer the … credential file … over a secure channel such as SSH … Let the VM own later refreshes." It also says: "Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available."
- Pi's alternative is the paste-the-final-redirect-URL fallback.

**Tokens** [doc] (token-reference):

- Access tokens last **1 hour** (`expires_in: 3600`).
- Refresh tokens last **30 days**, and "Each successful refresh returns a replacement refresh token with a fresh 30-day lifetime".
- The response also carries `earliest_refresh_at`.
- Refresh: POST `grant_type=refresh_token`, issued `client_id`, `refresh_token`, `resource` to `/api/accounts/oauth/token`.
- Revocation goes to the `revocation_endpoint` from `/.well-known/openid-configuration`.

**Inference** [doc]:

- Only `POST https://api.openai.com/v1/responses` is allowed, with `store:false, stream:true`. "Do not point it at ChatGPT's `backend-api` endpoints."
- Models come from `GET /v1/models`, filtered on `visibility=="list"`.
- **Not supported:** `previous_response_id` over HTTP, `max_output_tokens`, `temperature`, `prompt_cache_retention` and others, system-role items, and the hosted tools (file search, code interpreter, computer use, hosted MCP, `tool_search`).
- Pi already strips these when it sees a non-`sk-` key on `api.openai.com` (`isChatGPTSignIn`, `openai-responses.ts:44`).

**Usage and limits** [doc]:

- "Plan eligibility and usage limits apply. SIWC does not grant extra usage."
- Usage draws on "the included ChatGPT Work and Codex allowance or applicable credits".
- "For ChatGPT Plus users, the five-hour usage limit is shared across all apps … The five-hour usage limit does not apply for Pro users."
- Users can set a per-app weekly cap (10–100%) under ChatGPT Settings → Usage, and can disconnect under Settings → Security and login.
- Business admins must allow each app (Admin Console → Tenant settings → External access → "Use ChatGPT plan").
- When an admin blocks third-party agents, sign-in fails with **`3p_delegated_access_policy_denied`**. Pi maintainers pointed users at the legacy Codex login as the workaround (earendil-works/pi#11033, 2026-10-16).
- Plan availability differs between the help article ("Go, Plus, Pro, Business … Supported open-source tools remain available to all ChatGPT users") and the developer docs ("Eligible ChatGPT Plus and Pro users").

**Errors:** see the table in §1.5 and /errors-and-recovery. Also:

- `subscription_sharing_user_not_eligible` (403): do not retry.
- `subscription_sharing_unsupported_capability` (400): inspect `param`.
- Refresh failures `invalid_grant`, `refresh_token_reused`, `refresh_token_expired` and `refresh_token_invalidated` mean: clear the tokens and sign in again.

---

## 4. Terms (verbatim; dates as published)

**SIWC Terms** (openai.com/policies/sign-in-with-chatgpt-terms, Effective November 4, 2026):

- §1: "Obtain and use SIWC access and refresh tokens … only through OpenAI's supported sign-in flow and as authorized by the user. Do not ask users for their ChatGPT passwords or session cookies".
- §1: "**Any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment.**"
- §3.1, must not enable: "Pooling, transferring, reselling, gifting, or sharing ChatGPT plan usage or Authentication Tokens, except for token handling expressly permitted by these Terms." and "Using one user's subscription to fulfill another user's requests."
- §3.1: "**User control.** Requests must originate from the user's local runtime or a remote runtime only that user controls."
- §3.1: "**User authorization.** … arise from their activity or expressly authorized automations or background processes. Obtain express consent before background use. Another user's activity must not trigger requests to the authenticated user's account."
- §3.1: "**No charge.** Users must be able to use their ChatGPT plan through SIWC without paying you".
- §1: "Use your app's own name during sign-in … Do not impersonate OpenAI, another application or entity".
- §7: "We may … suspend or disable your application's access to SIWC if it violates these Terms".

**Codex app-server docs** (learn.chatgpt.com/docs/app-server, fetched 2026-11-20): "App-server authentication has never been permitted for commercial or hosted services."

**Terms of Use** (openai.com/policies/row-terms-of-use, effective January 1, 2026):

- "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account."
- You may not "Automatically or programmatically extract data or Output" or "circumvent any rate limits or restrictions".

**Help centre, ChatGPT Business models and limits** (help.openai.com/en/articles/12003714) lists as prohibited: "Abusive usage, such as automatically or programmatically extracting data. Sharing your account credentials or making your account available to anyone else. Reselling access or using ChatGPT to power third-party services."

**Pro tiers** (help.openai.com/en/articles/9793128): "Sharing account credentials, reselling access and automatically extracting data are prohibited. We may restrict access for misuse."

**Codex CI guide** [doc]: "Do not use this workflow for public or open-source repositories."

**Reading for Barrack** [inf]:

- _Self-hosted by the user for their own threads_, on SIWC: allowed. The control plane and sandboxes are the user's own infrastructure, the requests come from the user's activity (and background automation they consent to), and the tokens stay on infrastructure they control.
- _Self-hosted by an operator for a team_, or _hosted for other people_: SIWC calls this a "remotely hosted app" and requires the interest form or approval. Central token storage also conflicts with §1 unless OpenAI approves.
- Path A (Codex client) is "never permitted" for hosted or commercial use.
- **Design rule:** treat any deployment where the operator is not the ChatGPT account holder as hosted. Gate ChatGPT-plan sign-in behind an operator setting that defaults to off for multi-user installs, with text explaining the approval requirement.

**Enforcement reports (reports, not policy):**

- **Tibo Sottiaux** (Codex lead, X, 2026-08-21), about users whose limits seemed different: "many were using sub2api. Converting a subscription into api traffic to then re-serve or share across many users is not something we support and this type of usage gets flagged by our fraud-prevention systems. You are completely fine if you use your subscription through Sign in With ChatGPT, either through the official clients or through one of the many OSS clients (Pi, OpenCode, …)". This predates Pi's SIWC provider (Pi 0.99.0, 2026-09-29), so at that date "Pi" meant its Codex-client path.
- **aq.dev** (2026-08-21): developer-community threads describe Pro subscribers deactivated mid-session, with slow appeals. No firsthand ban for ordinary Pi or OpenCode use was found.
- **JetBrains/thinkrail #437** (2026-09-18): "found no concrete firsthand report … of an OpenAI account being banned specifically for ordinary pi Codex OAuth usage."

---

## 5. Storage design

Facts that decide it:

1. Refresh tokens rotate, and reuse is detected (`refresh_token_reused`), so exactly one refresher may exist per credential.
2. SIWC access tokens live 1 hour. Codex-client access tokens reportedly live about 10 days.
3. The agent runs as the same user as Pi, so **any token Pi can use, the agent can read**: from the file, the environment or `/proc`. The goal is that only short-lived access tokens ever enter a sandbox.
4. Pi re-reads `auth.json` on change [ran].
5. Daytona volumes [doc] (daytona.io/docs/en/volumes) are "FUSE-based mounts … stored in an S3-compatible object store … **not transactional. If two sandboxes write to the same path concurrently, the last write wins.**" They support `subpath` isolation and a limit of 100 per organisation.

**(a) Central credential, control plane refreshes, sandboxes get access tokens. RECOMMENDED.**

_Storage:_

- Store `{client_id, refresh_token, id_token, ext_agent_host_id, scopes, account sub/email}` per user in Postgres.
- Encrypt it with envelope encryption under a key the DB does not hold: an env or KMS key in the control plane, AES-GCM, with the user id as AAD.

_Refresh:_

- One refresher per credential, serialised with `SELECT … FOR UPDATE` or `pg_advisory_xact_lock(hash(cred_id))`.
- Persist the new refresh token in the **same transaction** as the token response. If the write fails, the old token is already dead.
- Refresh at T−10 min, or at `earliest_refresh_at`.

_Delivery to sandboxes:_

- Push `{provider, accessToken, expiresAt}` over the existing supervisor connection to every live sandbox of that user.
- The supervisor writes it into Pi's `auth.json` atomically (temp file + rename, mode 0600, owned by the agent user). Taking the same `proper-lockfile` lock is safer.

_How Pi accepts a bare access token_ [src+ran]:

- **SIWC.** Write `{"openai":{"type":"api_key","key":"<access token>"}}`.
  - The `openai` provider has api-key auth (`providers/openai.ts`).
  - A stored `api_key` is re-read on every file change [ran].
  - A non-`sk-` key sent to `api.openai.com/v1` is treated as SIWC and gets the field-stripping (`isChatGPTSignIn`). This heuristic is internal to Pi: pin the version and test on upgrade.
  - Pi never tries to refresh an `api_key` credential, so no rotation risk enters the sandbox.
  - An expired token yields 401 → error, so the push must arrive before expiry.
- **Alternatives:**
  - `--api-key` or `OPENAI_API_KEY`: fixed for the process lifetime, not refreshable.
  - `!command` keys: cached for the process lifetime (`resolve-config-value.ts:9`). Not suitable.
  - An extension calling `pi.registerProvider("openai", { baseUrl:"https://api.openai.com/v1", oauth:{ login, refreshToken: () => askSupervisor(), getApiKey: c => c.access } })` (`provider-composer.ts:359–377`): Pi's own lock then calls Barrack's refresh. This is cleaner semantically but has more surface; it is the fallback if the `api_key` trick breaks.
- **Codex client (Path A).** `openai-codex` is OAuth-only, so `--api-key` is ignored. Either:
  - add `models.json` `{"providers":{"openai-codex":{"apiKey":"unused"}}}`, which creates api-key auth for the provider (`composeApiKeyAuth`), and then store `{"openai-codex":{"type":"api_key","key":"<jwt>"}}`; or
  - store `{type:"oauth", access, refresh:"barrack-managed", expires:<real exp>}` and keep `expires` far enough ahead.
  - Both are [inf] for openai-codex; neither was run.

_Access-token lifetime:_ SIWC is 1 hour [doc]. The Codex client is about 10 days [report].

_Cost:_

- A refresher service and a key-management story.
- The push protocol plus the supervisor writer.
- Coupling to a Pi heuristic.
- A one-hour token readable by the agent.
- Under SIWC §1 this is "persistent storage … not local" unless the control plane is the user's own. That is fine for a self-host, and needs OpenAI's approval for hosted or multi-user installs.

**(b) Per-user persistent volume shared by the user's sandboxes, Pi's lock does the refresh. REJECT.**

- `proper-lockfile` relies on atomic `mkdir` and mtime staleness on a POSIX filesystem. On Daytona's S3-backed FUSE volumes, which are not transactional and last-write-wins, two sandboxes can both "win" the lock and both refresh. One then gets `refresh_token_reused`, and the family may be revoked.
- It would work for Docker containers that share a named local volume on **one host**, because they share a kernel and ext4.
- In both cases the 30-day refresh token is readable by every agent of that user, so a prompt-injected agent can exfiltrate a long-lived credential.
- It also couples the sandbox lifecycle to the credential.

**(c) One live sandbox per credential. REJECT as a design.**

- It contradicts "connect once, across threads", because concurrent threads of one user need concurrent model access.
- It is acceptable only as a degenerate case: the sandbox owns refresh, and `auth.json` is copied back to the control plane on stop. Even then the copy-back is the same as (a), with worse failure modes.

**(d) Proxy model traffic through the control plane, so no credential enters the sandbox. Feasible; keep it for Milestone 7.**

- Pi points at the proxy with a `models.json` `baseUrl` override and a per-sandbox Barrack token. The control plane injects `Authorization: Bearer <SIWC access>` and forwards to `api.openai.com/v1/responses`, streaming the SSE back.
- **Caveat** [src]: Pi decides "SIWC mode" only when `model.baseUrl === "https://api.openai.com/v1"`. With a proxy base URL, Pi will send `prompt_cache_retention` and `max_output_tokens`, which SIWC rejects. The proxy must strip them, or Barrack sets `compat` flags or uses a `before_provider_request` extension. Those are [inf].
- It is the strongest isolation: the agent never sees an OpenAI token.
- _Costs:_ all model bandwidth and latency go through the control plane, which becomes a single point of failure for every running thread; streaming must be proxied robustly; and it is the most "managed environment"-looking option for the terms.
- It does **not** conflict with "close to the sandbox" any more than (a) does, because (a) already centralises refresh. (d) can be layered on (a) later without changing sign-in.

**Recommendation: (a).** It works identically for Docker and Daytona, keeps the only rotating secret out of every sandbox, makes "connect once / survive restarts / many threads" trivial, and is the natural base for (d). For a single-user self-host, the control plane _is_ "local and under the user's control".

---

## 6. API keys per process [src]

- **Precedence:** runtime `--api-key` > `auth.json` entry > `models.json` `apiKey` > provider env var. A stored credential owns the provider, so the env var is consulted only when nothing is stored (`ai/src/auth/resolve.ts`).
- **Env var names** (`packages/ai/src/env-api-keys.ts:29–124`, `docs/providers.md`):
  - `openai` OPENAI_API_KEY; `anthropic` ANTHROPIC_API_KEY (also ANTHROPIC_OAUTH_TOKEN and ANTHROPIC_AUTH_TOKEN; **scrub these**); `azure` AZURE_OPENAI_API_KEY (+AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME); `google` GEMINI_API_KEY; `google-vertex` GOOGLE_CLOUD_API_KEY or ADC.
  - `groq` GROQ_API_KEY; `cerebras` CEREBRAS_API_KEY; `xai` XAI_API_KEY; `openrouter` OPENROUTER_API_KEY; `vercel-ai-gateway` AI_GATEWAY_API_KEY; `mistral` MISTRAL_API_KEY; `deepseek` DEEPSEEK_API_KEY; `nvidia` NVIDIA_API_KEY.
  - `zai` ZAI_API_KEY; `zai-coding-cn` ZAI_CODING_CN_API_KEY; `minimax` MINIMAX_API_KEY; `minimax-cn` MINIMAX_CN_API_KEY; `moonshotai`/`moonshotai-cn` MOONSHOT_API_KEY.
  - `huggingface` HF_TOKEN; `fireworks` FIREWORKS_API_KEY; `together` TOGETHER_API_KEY; `baseten` BASETEN_API_KEY; `opencode`/`opencode-go` OPENCODE_API_KEY; `kimi-coding` KIMI_API_KEY; `meta` META_API_KEY.
  - `cloudflare-workers-ai`/`cloudflare-ai-gateway` CLOUDFLARE_API_KEY; `radius` RADIUS_API_KEY; `typesafe` TYPESAFE_API_KEY; `ant-ling` ANT_LING_API_KEY.
  - `xiaomi` XIAOMI_API_KEY, plus the token-plan variants; the `qwen-token-plan*` variants; `github-copilot` COPILOT_GITHUB_TOKEN.
  - Bedrock uses the AWS chain.
- **`auth.json` form:** `{"<provider>":{"type":"api_key","key":"…"}}`. It is re-read on change [ran], so a settings change can reach running threads without a restart.
- **Settings page:**
  - Store `(provider id, key)` pairs encrypted per user.
  - At thread start, the supervisor writes all of the user's pairs into the agent's `auth.json`, or exports only the needed env var into a scrubbed env.
  - A thread names a model as `--model <provider>/<modelId>[:<thinking>]`. Switch mid-thread with RPC `set_model {provider, modelId}` and `set_thinking_level`.
  - Populate the model picker from RPC `get_available_models`. It lists only models whose provider has credentials.
  - `--api-key` "requires a model selected through `--model`" and applies to that model's provider only (`docs/cli.md:69–70`).
  - Reject an `anthropic` `oauth` credential, since Claude subscription sign-in is out of scope.

---

## 7. Durability over the next year, and the recommendation

**Path B (SIWC):**

- Official, with published terms and docs updated in November 2026.
- Pi is a named partner, and OpenAI staff steer third-party developers to it.
- _Risks:_ it is a "preview" (its limitations page), there is no device code, and admins can block it.

**Path A (Codex client):**

- It works today and has the device code.
- OpenAI docs ask third-party apps to migrate off it; it is first-party-client reuse; and hosted use is "never permitted".
- I expect it to keep working for local OSS use in the short term, but it is the more likely of the two to be restricted [inf].

**Route 2:**

- Same Path A tokens, plus a second harness.
- Its only advantage is better rate-limit data.

**Recommendation:**

- **Primary:** SIWC on Pi's `openai` provider.
  - Barrack implements the authorize/exchange flow itself and uses `agent_name_hint="Barrack"`.
  - One `ext_agent_host_id` per user per Barrack installation.
  - The issued `client_id` is reused.
  - The control plane owns refresh, per design (a).
- **UX substitute for the device code:** "Open link → approve → copy the address your browser ends on → paste into Barrack". Optionally offer a tiny local helper (`npx barrack-connect`) that runs the loopback listener on the user's laptop and uploads the result, which is OpenAI's documented "complete OAuth locally and transfer" pattern.
- **Fallback for headless or phone-only users, and for workspaces that block 3rd-party agents:** Pi `openai-codex` device code (Path A).
  - Self-host only.
  - Clearly labelled.
  - Same storage design.

**What would change this:**

- OpenAI ships a device-code or browserless SIWC variant: switch fully to Path B, then drop Path A.
- OpenAI blocks Path A for non-Codex clients: drop the fallback.
- SIWC approval is granted for a hosted Barrack: enable hosted mode under the approval's conditions.
- SIWC terms are clarified to allow operator-stored tokens for self-hosted teams.
- Pi removes the `isChatGPTSignIn` heuristic: move to the extension-provider override in §5(a).

---

## 8. Not verified (needs real credentials or OpenAI confirmation)

1. Any live sign-in (device code or SIWC), and the real token responses (`expires_in`, `earliest_refresh_at`, scopes).
2. The Codex-client access-token lifetime (about 10 days is a third-party report).
3. Whether `refresh_token_reused` also revokes the whole token family.
4. The exact server behaviour when device-code sign-in is disabled. It appears to be shown in the browser only, with the poll staying 403/404, but I could not observe it.
5. The real usage-limit payloads: the Codex 429 body and `x-codex-*-reset-at` headers on the SSE path, the WebSocket error event shape, and whether SIWC responses carry any reset hint.
6. That the Pi `openai` provider accepts a SIWC access token stored as `type:"api_key"` end to end. The mechanism was [ran] with a mock provider; the SIWC detection is from source only.
7. That the `openai-codex` api-key override (`models.json` `apiKey` + stored `api_key`) works.
8. Whether SIWC requests from several sandboxes (different IPs) under one host id and client id raise any flag.
9. Whether OpenAI regards a self-hosted multi-user Barrack as "remotely hosted".
10. Whether Daytona FUSE volumes make `mkdir` atomic across sandboxes. The docs say only "not transactional, last write wins", so I treated it as unsafe.
