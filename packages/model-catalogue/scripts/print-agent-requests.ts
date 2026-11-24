import { buildAgentRequests } from "./agent-requests.js";

/**
 * Writes every request `agent-requests.ts` builds through the pinned Pi to
 * standard output, one JSON line each, for the control plane's test that
 * runs them through the model proxy's own checks: it cannot import Pi,
 * which only this package installs. `node --import tsx print-agent-requests.ts`
 */
await buildAgentRequests((request) => {
  process.stdout.write(`${JSON.stringify(request)}\n`);
});
