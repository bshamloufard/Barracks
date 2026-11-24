import { OwnerAdmission } from "../authentication/owner-admission.js";
import type { UserAdmission } from "../authentication/user-admission.js";
import type { Logger } from "../logger.js";
import type { ModelCredentials } from "../model-access/model-credentials.js";
import type { ModelUsage } from "../model-usage/model-usage.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ThreadEndingListener } from "../thread-relay/thread-endings.js";
import type { ThreadStore } from "../threads/thread-store.js";
import type { UserStore } from "../users/user-store.js";
import { ModelProxy } from "./model-proxy.js";
import { ModelProxyAuthorization } from "./model-proxy-authorization.js";
import { defaultModelProxyLimits, type ModelProxyLimits } from "./model-proxy-limits.js";
import type { ModelProxyTokens } from "./model-proxy-tokens.js";

export type ModelProxyAssembly = {
  threadStore: ThreadStore;
  threadEventLog: ThreadEventLog;
  userStore: UserStore;
  admission: UserAdmission;
  credentials: ModelCredentials;
  tokens: ModelProxyTokens;
  usage: ModelUsage;
  /** Where thread endings are announced: the thread relays. */
  endings: { listenForEndings(listener: ThreadEndingListener): void };
  /** For tests and local development only; see `findRelayedRoute`. */
  upstreamOrigin: string | undefined;
  limits?: Partial<ModelProxyLimits>;
  logger: Logger;
};

/**
 * Builds the model proxy and revokes a thread's tokens, and ends its
 * requests in flight here, as soon as its sandbox begins stopping or the
 * thread begins being deleted on this control plane. Elsewhere, the proxy
 * refuses the thread's tokens anyway once its sandbox is no longer recorded
 * running, and a deleted thread's tokens go with its record.
 */
export function assembleModelProxy(assembly: ModelProxyAssembly): ModelProxy {
  const { tokens, logger } = assembly;
  const proxy = new ModelProxy({
    authorization: new ModelProxyAuthorization({
      threadStore: assembly.threadStore,
      threadEventLog: assembly.threadEventLog,
      tokens,
      credentials: assembly.credentials,
      ownerAdmission: new OwnerAdmission(assembly.admission, assembly.userStore),
      usage: assembly.usage,
    }),
    usage: assembly.usage,
    limits: { ...defaultModelProxyLimits, ...assembly.limits },
    upstreamOrigin: assembly.upstreamOrigin,
    logger: logger.child({ component: "model-proxy" }),
  });
  assembly.endings.listenForEndings((threadId, ending) => {
    proxy.cancelThread(threadId);
    tokens.revokeThread(threadId).then(
      () => logger.info({ threadId, ending }, "Revoked the thread's model proxy tokens"),
      (error: unknown) =>
        logger.error(
          { err: error, threadId, ending },
          "Could not revoke the thread's model proxy tokens; the proxy refuses them anyway once its sandbox is no longer running",
        ),
    );
  });
  return proxy;
}
