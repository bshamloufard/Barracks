# @barrack/fake-chatgpt-sign-in

A stand-in for the authorization server of OpenAI's ["Sign in with ChatGPT"](https://developers.openai.com/siwc) programme, so the tests of connecting a ChatGPT plan need no OpenAI account and attempt no real sign-in. It answers as the programme's documentation (read 2026-11-25) describes:

- discovery at `/.well-known/openid-configuration`, and its RS256 signing keys at `/.well-known/jwks.json`;
- `/api/accounts/authorize`, which checks every parameter the documentation requires (`response_type`, `client_id`, `ext_agent_host_id`, a `127.0.0.1` redirect to `/auth/callback`, the plan's scopes and resource, PKCE with S256, `state`, `nonce`, and `agent_name_hint` only on a first registration) and stands for the user approving: `approve` returns the address the browser would be sent to, which a test pastes as the user would; `deny` the one for a user who declines. A first sign-in, with `dynamic_agent_client`, registers a client and returns its issued `client_id` on that address;
- `/api/accounts/oauth/token`: a code, once, within a minute, for the verifier, redirect and resource it was issued for, gives an access token of an hour, a refresh token and an ID token; a refresh token gives a new pair. A refresh token presented a second time is reuse: it is refused with `refresh_token_reused` and the whole sign-in is revoked (the documentation leaves open whether OpenAI does that; the stand-in takes the stricter reading);
- `/api/accounts/oauth/revoke`, revoking a sign-in by its refresh token.

Tests can also revoke an account's sign-ins as ChatGPT's settings would, make token requests fail or slow, make the next ID token carry wrong claims or the next grant leave out plan usage, and ask whether an access token is valid (`checkAccessToken`), which the [mock model server](../mock-model-server) uses to answer plan requests. It has never been compared with OpenAI's real server; the [first-deployment checklist](../../docs/deployment.md#first-deployment-checklist) lists what a real sign-in must confirm.

The control plane's ChatGPT plan tests and the end-to-end test of a plan with the real Pi use it. Everything is in [`src/fake-chatgpt-sign-in.ts`](src/fake-chatgpt-sign-in.ts). It has no tests of its own and no build step; `pnpm typecheck` checks it.
