# @barrack/fake-github

A stand-in for GitHub, so no test reaches it: the REST and OAuth endpoints the control plane calls, answering as GitHub documents them, and Git repositories over smart HTTP that check tokens the way GitHub does. An installation token can read only its repositories and push only with `contents: write`; users have push or read access to repositories; the App is installed on some of them; and signing in hands out codes bound to a PKCE challenge. It records every request, so a test can say exactly what Barrack asked. It has never been compared with GitHub itself; the [first-deployment checklist](../../docs/deployment.md#first-deployment-checklist) lists what a real GitHub App must confirm.

The control plane's GitHub and publication tests, the supervisor's workspace tests and the end-to-end repository tests use it.

## Main files

- [`src/fake-github.ts`](src/fake-github.ts): the server and its records.
- [`src/git-http-backend.ts`](src/git-http-backend.ts): Git over HTTP, through `git http-backend`.
- [`src/local-repositories.ts`](src/local-repositories.ts): making and reading the bare repositories it serves.

`pnpm test` runs its own test, [`src/fake-github.test.ts`](src/fake-github.test.ts). It needs `git` on the path.
