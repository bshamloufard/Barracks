# @barrack/web

The Barrack web client. Before anything else it asks the control plane how this installation signs users in (`GET /api/client-configuration`), so one build serves any installation:

- **Signing in** (Supabase): one screen asks for an email address, then for the six-digit code Supabase emails to it. supabase-js, loaded only for Supabase installations, keeps the session in the browser and refreshes its token. A signed-in user the installation does not admit is told so and can sign out; the control plane decides, not the page.
- **Development mode** (`pnpm dev`): no sign-in; the page uses the fixed token the control plane hands out.

Then it has three pages, each showing only the signed-in user's own threads and settings, with who is signed in and **Sign out** in the header:

- **The thread list** (`/`): every thread, the most recently active first, each with its title (from its first message, or "New thread"), what its sandbox is doing (starting, running, stopping, stopped, waking, failed, deleting), whether the agent is working, and when it was last active; it refreshes itself, every two seconds while a sandbox is changing state and every fifteen otherwise. **New thread** asks for a model (a provider, those the user has a key for first, then one of the models the agent's catalogue lists, or any other model identifier) and asks the control plane to create a thread (and its sandbox) on it, and opens it; at the limit on running sandboxes, or without a key for the model's provider, the control plane's refusal is shown instead.
- **A thread** (`/?thread={threadId}`): connects to the control plane, shows the conversation as it streams in, and lets you send the agent messages and interrupt it. A line under the header says what the sandbox is doing ("Waking the sandbox…", "Stopping the sandbox…", stopped, failed and why), with **Stop**, **Resume** and **Delete** where they apply; deleting asks for confirmation first, then returns to the list. The thread's model is shown with where its key lives ("Your key stays on the server" or "Your key is placed in the sandbox"), what the thread has used (read again whenever the agent stops), **Change model**, which switches it from the agent's next run, and a warning when the user has no key for it. A reply that failed for want of a key, a rejected key, an exhausted quota, a rate limit or the user's usage cap says so in plain words with the next step (and a link to Settings where that is the fix), with the provider's own words beneath. A message can be sent while the agent is starting, away or stopped: the control plane records it, wakes a stopped sandbox, and hands the message over once the agent connects, and until then the page marks it as waiting for the agent. Closing the tab, losing the network or reloading the page loses nothing: on reconnect it tells the control plane the last event it holds and is sent exactly what it missed.

  Above the conversation, **the live desktop**: the sandbox's screen, drawn by noVNC (loaded only when a desktop is first shown) and scaled to the page's width, so it works at phone width too. Every viewer watches; **Take control** lets this page's mouse and keyboard through to the desktop, and the agent's computer tool stands back until **Give control back** (or this page's desktop connection closing). The page says which of the user's windows holds control, and, while this one does, that anything typed there, passwords included, the agent can read. The desktop's socket authenticates with its first message like the thread's, is handed to noVNC once the control plane says the desktop is ready, and closes while the tab is hidden, reopening when it is shown. A stopped sandbox's desktop is not shown: the panel says so and offers **Wake the sandbox**; a sandbox without a desktop (a `pnpm dev` thread) says that instead. Computer tool calls read as words in the conversation ("Clicked at (400, 383)").

- **Settings** (`/?page=settings`): the user's model keys, one per provider, listed by provider, when added and last four characters, never more, and where the key lives for that provider, with **Replace** and **Remove**, and a form to add one, with the settings the provider needs beside its key and what placing it there means; their model usage (the cap's window against the cap, the last 30 days by model and how each number was counted) and a cap of their own; and their link to GitHub.

It is deliberately bare: React and a small hand-written stylesheet, no UI framework and no router.

**Every request and connection carries the access token.** A request refused with `401` is retried once with a refreshed token, and refused again signs the page out. Only a definite answer signs it out: when a token cannot be had because the refresh did not reach Supabase (a laptop waking before its network, say), the request fails saying so, a thread's connection tries again with backoff, and the stored session is kept; supabase-js reports that case as an `AuthRetryableFetchError` ([`src/authentication/supabase-session-answer.ts`](src/authentication/supabase-session-answer.ts)). A thread's WebSocket obtains its token before it opens, so a slow refresh cannot use up the control plane's few seconds for authenticating, and sends the token as its first message and sends nothing else until the replay announcement arrives; it sends each refreshed token on the open connection, and when the control plane closes it because the token expired (a tab left hidden pauses supabase-js's refreshing), it refreshes the token and reconnects at once from the last event it holds. An authentication that timed out (`authenticationTimedOut`) is retried with backoff, never treated as a refused sign-in.

## How it is organised

| Path                  | What it holds                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/page-address.ts` | Which page the address shows, and the address of each. Tested.                                                                                                                                                                                                       |
| `src/api/`            | The client configuration, requests carrying the access token (retried once after a refresh; tested), and the threads, repositories and model access APIs, each answer checked against the protocol.                                                                  |
| `src/authentication/` | The sign-in services (Supabase, development), the pure sign-in reducer (tested), and the page's session, which hands out tokens and hears refusals (tested).                                                                                                         |
| `src/thread-list/`    | The thread list page's pure reducer (tested) and the hook that loads the list and creates threads.                                                                                                                                                                   |
| `src/model-access/`   | Loading the model catalogue and the user's keys, and the pure rules for offering providers and models and saying why one cannot run yet (tested).                                                                                                                    |
| `src/thread-state/`   | The pure reducer that is the only code changing what a thread's page shows, and a small store around it. Tested.                                                                                                                                                     |
| `src/connection/`     | The thread's WebSocket: its rules as a pure state machine (authenticate first, re-send refreshed tokens, reconnect on expiry or with capped backoff, stop when reconnecting cannot help; tested), the socket that carries them out, and polling the thread's record. |
| `src/desktop/`        | The desktop viewer: its rules as a pure state machine (tested), the socket that carries them out and hands itself to noVNC, and the hook the panel uses.                                                                                                             |
| `src/use-thread.ts`   | Follows a thread's record and, once it exists, its live connection, for as long as a component is mounted.                                                                                                                                                           |
| `src/components/`     | The pages: the session gate, signing in, not allowed, thread list, status line, sandbox controls, conversation, tool execution rows, message box.                                                                                                                    |
| `src/presentation/`   | Small pure helpers that turn protocol values and state into what the user reads. Tested.                                                                                                                                                                             |

**How the page learns what the sandbox is doing.** The thread's record (`GET /api/threads/{threadId}`) carries its sandbox's state. The thread page fetches it when it opens, every second while the sandbox is changing state, every fifteen seconds otherwise, and at once when the WebSocket shows something that likely changed it: the supervisor connecting or leaving, or a new message (which may have woken the sandbox). A failure's reason comes with it. Whether the agent is reachable right now comes, as before, from the thread's WebSocket.

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
