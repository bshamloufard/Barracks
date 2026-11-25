# @barrack/mock-model-server

A stand-in for a model provider, so tests can run the real Pi agent with no network and no API key. It speaks three wire formats, told apart by path: OpenAI's Chat Completions (`…/chat/completions`), Anthropic's Messages (`…/v1/messages`) and OpenAI's Responses (`…/responses`), streaming each answer as that provider documents, with its usage. It has never been compared with a real provider's answers; the [first-deployment checklist](../../docs/deployment.md#first-deployment-checklist) lists what a real run must confirm.

What it answers depends on words in the newest user message (`RUN_TOOL`, `FAIL_ONCE`, `REJECT_KEY`, `EXHAUST_QUOTA`, `RATE_LIMIT`, and others), so a test can make the agent call a tool, crash, or meet each kind of provider error; the list is `mockModelTriggers` in [`src/mock-model-server.ts`](src/mock-model-server.ts). Every request is recorded, with the credential it presented, so a test can check which key or proxy token reached the provider.

Given a way to recognise a ChatGPT plan's access tokens (from the [stand-in for OpenAI's sign-in](../fake-chatgpt-sign-in)), it answers requests presenting one as OpenAI's "Sign in with ChatGPT" programme documents ([`src/chatgpt-plan.ts`](src/chatgpt-plan.ts)): only `store: false` and `stream: true`, none of the members, items and hosted tools the programme refuses (`subscription_sharing_unsupported_capability`, naming the `param`), an account not eligible or a token no longer valid refused with the programme's codes, the plan's usage limit for a message containing `EXHAUST_PLAN` or an account a test declared spent, and the plan's models at `GET /v1/models`.

The sandbox supervisor's Pi integration test, the control plane's model proxy tests and the end-to-end tests use it.

## Main files

- [`src/mock-model-server.ts`](src/mock-model-server.ts): the server, its triggers and the record of requests.
- [`src/wire-formats.ts`](src/wire-formats.ts): reading and writing each provider's request, answer, usage and error shapes.
- [`src/chatgpt-plan.ts`](src/chatgpt-plan.ts): how a request on a ChatGPT plan is checked and refused, and the plan's models.
- [`src/desktop-scripts.ts`](src/desktop-scripts.ts), [`src/screenshot-reading.ts`](src/screenshot-reading.ts): scripts that drive the agent's computer tool for the desktop tests.

It has no tests of its own and no build step; the tests that use it import its sources. `pnpm typecheck` checks it.
