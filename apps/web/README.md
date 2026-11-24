# @barrack/web

The Barrack web client. Before anything else it asks the control plane how this installation signs users in (`GET /api/client-configuration`), so one build serves any installation:

- **Signing in** (Supabase): one screen asks for an email address, then for the six-digit code Supabase emails to it. supabase-js, loaded only for Supabase installations, keeps the session in the browser and refreshes its token. A signed-in user the installation does not admit is told so and can sign out; the control plane decides, not the page.
- **Development mode** (`pnpm dev`): no sign-in; the page uses the fixed token the control plane hands out.

Then it has two pages, each showing only the signed-in user's own threads, with who is signed in and **Sign out** in the header:

- **The thread list** (`/`): every thread, newest first, with when it was created and whether its sandbox is starting, ready or failed, and a **New thread** button that asks the control plane to create a thread (and its sandbox) and opens it.
- **A thread** (`/?thread={threadId}`): connects to the control plane, shows the conversation as it streams in, and lets you send the agent messages and interrupt it. Until the agent first connects it says the thread is starting its sandbox; if the sandbox could not be created it shows the reason. A message can be sent while the agent is starting or away: the control plane records it and hands it over once the agent connects, and until then the page marks it as waiting for the agent. Closing the tab, losing the network or reloading the page loses nothing: on reconnect it tells the control plane the last event it holds and is sent exactly what it missed.

It is deliberately bare: React and a small hand-written stylesheet, no UI framework and no router.

**Every request and connection carries the access token.** A request refused with `401` is retried once with a refreshed token, and refused again signs the page out. Only a definite answer signs it out: when a token cannot be had because the refresh did not reach Supabase (a laptop waking before its network, say), the request fails saying so, a thread's connection tries again with backoff, and the stored session is kept; supabase-js reports that case as an `AuthRetryableFetchError` ([`src/authentication/supabase-session-answer.ts`](src/authentication/supabase-session-answer.ts)). A thread's WebSocket obtains its token before it opens, so a slow refresh cannot use up the control plane's few seconds for authenticating, and sends the token as its first message and sends nothing else until the replay announcement arrives; it sends each refreshed token on the open connection, and when the control plane closes it because the token expired (a tab left hidden pauses supabase-js's refreshing), it refreshes the token and reconnects at once from the last event it holds. An authentication that timed out (`authenticationTimedOut`) is retried with backoff, never treated as a refused sign-in.

## How it is organised

| Path                  | What it holds                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/page-address.ts` | Which page the address shows, and the address of each. Tested.                                                                                                                                                                                                       |
| `src/api/`            | The client configuration, requests carrying the access token (retried once after a refresh; tested), and the threads API, each answer checked against the protocol.                                                                                                  |
| `src/authentication/` | The sign-in services (Supabase, development), the pure sign-in reducer (tested), and the page's session, which hands out tokens and hears refusals (tested).                                                                                                         |
| `src/thread-list/`    | The thread list page's pure reducer (tested) and the hook that loads the list and creates threads.                                                                                                                                                                   |
| `src/thread-state/`   | The pure reducer that is the only code changing what a thread's page shows, and a small store around it. Tested.                                                                                                                                                     |
| `src/connection/`     | The thread's WebSocket: its rules as a pure state machine (authenticate first, re-send refreshed tokens, reconnect on expiry or with capped backoff, stop when reconnecting cannot help; tested), the socket that carries them out, and polling the thread's record. |
| `src/use-thread.ts`   | Follows a thread's record and, once it exists, its live connection, for as long as a component is mounted.                                                                                                                                                           |
| `src/components/`     | The pages: the session gate, signing in, not allowed, thread list, status line, conversation, tool execution rows, message box.                                                                                                                                      |
| `src/presentation/`   | Small pure helpers that turn protocol values and state into what the user reads. Tested.                                                                                                                                                                             |

**How the page learns that a sandbox failed.** The thread's record (`GET /api/threads/{threadId}`) carries its sandbox's state. The thread page fetches it when it opens and again every second while the sandbox is being created, and stops once it is ready or failed; a failure's reason comes with it. Whether the agent is reachable right now comes, as before, from the thread's WebSocket.

## Configuration

| Setting                            | Default | Meaning                                                                                                     |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `BARRACK_CONTROL_PLANE_PORT` (dev) | `8787`  | Where the Vite dev server forwards `/api/…`, `/threads/…` WebSockets and `/health` (always on `127.0.0.1`). |

The page always talks to the control plane at its own origin: through Vite's proxy in development, or directly when the control plane serves the built page. The control plane only accepts origins on its allow list, which by default covers `http://localhost:5173` and `http://127.0.0.1:5173`. Where to sign in comes from the control plane, so nothing about Supabase is built into the page; it talks to Supabase directly, at the URL the control plane gives.

## Running it

`pnpm dev` at the repository root runs it with a control plane. To run it on its own against a control plane that is already running (see [its README](../control-plane/README.md)), from the repository root:

```sh
pnpm --filter @barrack/web dev
```

and open <http://localhost:5173/>.

To build the static files the control plane serves in production:

```sh
pnpm build   # writes apps/web/dist
```
