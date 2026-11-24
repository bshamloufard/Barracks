# @barrack/model-catalogue

The model providers and models the pinned [Pi](https://github.com/earendil-works/pi) agent supports, for the control plane to offer users without installing or running Pi: every provider Pi can use with an API key, what its key login asks for (the key, and any settings such as Cloudflare's account identifier, named as Pi reads them), and the chat models Pi lists for it, the common providers first.

- [`model-catalogue.json`](model-catalogue.json) is generated, never edited by hand. Its shape is `ModelCatalogue` in [`@barrack/protocol`](../protocol/src/model-access.ts).
- [`src/index.ts`](src/index.ts) reads and checks it once: `modelCatalogue`, and `findCatalogueProvider(providerId)`.
- [`src/relayed-providers.ts`](src/relayed-providers.ts) is the one list of providers whose traffic the control plane's model proxy relays, so their keys stay on the server, with each one's wire formats and own addresses; `modelCatalogue` marks every provider `kept_on_server` or `placed_in_sandbox` from it. [`scripts/relayed-providers-match-pinned-agent.test.ts`](scripts/relayed-providers-match-pinned-agent.test.ts) checks every listed provider's models, as the pinned Pi lists them, against it.
- [`scripts/read-agent-catalogue.ts`](scripts/read-agent-catalogue.ts) builds it from Pi's own model runtime, running each provider's key login with made-up answers to learn what it asks for. Pi is a development dependency only, so nothing that depends on this package at run time installs it.

## Regenerating it

After changing the Pi version the [sandbox supervisor](../../apps/sandbox-supervisor) pins (change this package's development dependency to the same version):

```sh
pnpm install
pnpm --filter @barrack/model-catalogue generate
```

[`scripts/catalogue-matches-pinned-agent.test.ts`](scripts/catalogue-matches-pinned-agent.test.ts) fails until then: it checks that this package's Pi is the supervisor's, and that generating the catalogue again gives exactly the committed file.

## What it does not say

It is a snapshot of what Pi bundles. Pi refreshes its own list online, providers add models between Pi releases, and a user may have configured a provider of their own, so clients let a user enter any `provider/model`; whether Pi knows it is found out when the thread's agent starts on it.
