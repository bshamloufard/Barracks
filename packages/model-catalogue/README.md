# @barrack/model-catalogue

The model providers and models the pinned [Pi](https://github.com/earendil-works/pi) agent supports, for the control plane to offer users without installing or running Pi: every provider Pi can use with an API key, what its key login asks for (the key, and any settings such as Cloudflare's account identifier, named as Pi reads them), and the chat models Pi lists for it, the common providers first.

- [`model-catalogue.json`](model-catalogue.json) is generated, never edited by hand. Its shape is `ModelCatalogue` in [`@barrack/protocol`](../protocol/src/model-access.ts).
- [`src/index.ts`](src/index.ts) reads and checks it once: `modelCatalogue`, and `findCatalogueProvider(providerId)`.
- [`src/relayed-providers.ts`](src/relayed-providers.ts) is the one list of providers whose traffic the control plane's model proxy relays, so their keys stay on the server, with each one's wire formats and own addresses; `modelCatalogue` marks every provider `kept_on_server` or `placed_in_sandbox` from it. [`scripts/relayed-providers-match-pinned-agent.test.ts`](scripts/relayed-providers-match-pinned-agent.test.ts) checks every listed provider's models, as the pinned Pi lists them, against it.
- [`agent-request-shapes.json`](agent-request-shapes.json) is the allow-list of the control plane's model proxy, also generated: what the pinned Pi's requests to the relayed providers hold, per wire format (the `type` of each conversation item, content part, image source, tool and cache marker, and each `anthropic-beta` value) and per provider (each top-level member and the values it takes, a count standing for any count). [`scripts/agent-requests.ts`](scripts/agent-requests.ts) builds those requests through Pi's own code, for every model Pi lists for a relayed provider at every thinking level and prompt cache retention, catching each at the HTTP client; [`scripts/read-agent-request-shapes.ts`](scripts/read-agent-request-shapes.ts) reads them into the list. [`scripts/agent-request-shapes-match-pinned-agent.test.ts`](scripts/agent-request-shapes-match-pinned-agent.test.ts) fails when Pi sends something the list does not allow, or the list allows something Pi was not seen to send, and checks that every name on it is written by Pi's request builders.
- [`scripts/read-agent-catalogue.ts`](scripts/read-agent-catalogue.ts) builds it from Pi's own model runtime, running each provider's key login with made-up answers to learn what it asks for. Pi is a development dependency only, so nothing that depends on this package at run time installs it.

## Regenerating it

After changing the Pi version the [sandbox supervisor](../../apps/sandbox-supervisor) pins (change this package's development dependency to the same version):

```sh
pnpm install
pnpm --filter @barrack/model-catalogue generate
```

[`scripts/catalogue-matches-pinned-agent.test.ts`](scripts/catalogue-matches-pinned-agent.test.ts) fails until then: it checks that this package's Pi is the supervisor's, and that generating the catalogue again gives exactly the committed file; the allow-list's test does the same for `agent-request-shapes.json`, so every upgrade of Pi regenerates the list the model proxy relays against. Read the list's difference before committing it: a new member, type or value is something Pi has begun to send, and so something the proxy will relay.

## What it does not say

It is a snapshot of what Pi bundles. Pi refreshes its own list online, providers add models between Pi releases, and a user may have configured a provider of their own, so clients let a user enter any `provider/model`; whether Pi knows it is found out when the thread's agent starts on it.
