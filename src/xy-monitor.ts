// Monitor for XY channel WebSocket connections
// Follows feishu/monitor.account.ts and feishu/monitor.transport.ts pattern
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveXYConfig } from "./xy-config.js";
import { getXYWebSocketManager, removeXYWebSocketManager } from "./xy-client.js";
import { handleXYMessage } from "./xy-bot.js";
import type { A2AJsonRpcRequest } from "./types.js";

export type MonitorXYOpts = {
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  setStatus?: (status: Omit<ChannelAccountSnapshot, "accountId">) => void;
};

/**
 * Per-session serial queue that ensures messages from the same session are processed
 * in arrival order while allowing different sessions to run concurrently.
 * Following feishu/monitor.account.ts pattern.
 */
function createSessionQueue() {
  const queues = new Map<string, Promise<void>>();
  return (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(sessionId, next);
    void next.finally(() => {
      if (queues.get(sessionId) === next) {
        queues.delete(sessionId);
      }
    });
    return next;
  };
}

/**
 * Monitor XY channel WebSocket connections.
 * Keeps the connection alive until abortSignal is triggered.
 */
export async function monitorXYProvider(opts: MonitorXYOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for XY monitor");
  }

  const runtime = opts.runtime;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const account = resolveXYConfig(cfg);
  if (!account.enabled) {
    throw new Error(`XY account is disabled`);
  }

  const accountId = opts.accountId ?? "default";

  // Create trackEvent function to report health to OpenClaw framework
  const trackTransportActivity = () => {
    const now = Date.now();
    opts.setStatus?.({ lastEventAt: now, lastTransportActivityAt: now });
  };

  // 🔍 Diagnose WebSocket managers before gateway start
  // console.log("🔍 [DIAGNOSTICS] Checking WebSocket managers before gateway start...");
  // diagnoseAllManagers();

  // Get WebSocket manager (cached)
  const wsManager = getXYWebSocketManager(account);

  // ✅ Set health event callback for heartbeat reporting
  // This ensures OpenClaw's health-monitor sees activity and doesn't trigger stale-socket restarts
  wsManager.setHealthEventCallback(trackTransportActivity);

  // Track active message processing to detect duplicates
  const activeMessages = new Set<string>();

  // Create session queue for ordered message processing
  const enqueue = createSessionQueue();

  return new Promise<void>((resolve) => {
    let cleanedUp = false;

    // Event handlers (defined early so they can be referenced in cleanup)
    const messageHandler = (message: A2AJsonRpcRequest) => {
      // Extract sessionId from message for queue routing
      const sessionId = message.params?.sessionId || message.id;
      const messageKey = `${sessionId}::${message.id}`;

      log(`[MONITOR-HANDLER] messageHandler triggered: sessionId=${sessionId}, messageId=${message.id}`);

      const now = Date.now();
      opts.setStatus?.({
        lastEventAt: now,
        lastInboundAt: now,
        lastMessageAt: now,
      });

      if (activeMessages.has(messageKey)) {
        error(`[MONITOR-HANDLER] Duplicate message detected! messageKey=${messageKey}`);
        return;
      }

      activeMessages.add(messageKey);
      log(`[MONITOR-HANDLER] Active messages count: ${activeMessages.size}, messageKey: ${messageKey}`);

      const task = async () => {
        try {
          log(`[MONITOR-HANDLER] Starting handleXYMessage for messageKey=${messageKey}`);
          await handleXYMessage({
            cfg,
            runtime,
            message,
            accountId,
          });
          log(`[MONITOR-HANDLER] Completed handleXYMessage for messageKey=${messageKey}`);
        } catch (err) {
          error(`XY gateway: error handling message: ${String(err)}`);
        } finally {
          activeMessages.delete(messageKey);
        }
      };
      void enqueue(sessionId, task).catch((err) => {
        error(`XY gateway: queue processing failed for session ${sessionId}: ${String(err)}`);
        activeMessages.delete(messageKey);
      });
    };

    const connectedHandler = () => {
      log(`XY gateway: connected`);
      const now = Date.now();
      opts.setStatus?.({
        connected: true,
        running: true,
        statusState: "ready",
        lastConnectedAt: now,
        lastEventAt: now,
        lastTransportActivityAt: now,
        lastError: null,
      });
    };

    const disconnectedHandler = () => {
      console.warn(`XY gateway: disconnected`);
      opts.setStatus?.({
        connected: false,
        statusState: "disconnected",
        lastDisconnect: { at: Date.now() },
      });
    };

    const errorHandler = (err: Error) => {
      error(`XY gateway: error: ${String(err)}`);
      opts.setStatus?.({
        lastError: err.message,
        lastEventAt: Date.now(),
      });
    };

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      log("XY gateway: cleaning up...");
      opts.abortSignal?.removeEventListener("abort", handleAbort);

      // Remove event handlers to prevent duplicate calls on gateway restart
      wsManager.off("message", messageHandler);
      wsManager.off("connected", connectedHandler);
      wsManager.off("disconnected", disconnectedHandler);
      wsManager.off("error", errorHandler);

      // ✅ Remove manager from cache - this will also disconnect
      // removeXYWebSocketManager internally calls manager.disconnect()
      removeXYWebSocketManager(account);

      activeMessages.clear();
      opts.setStatus?.({
        connected: false,
        running: false,
        statusState: "stopped",
        lastStopAt: Date.now(),
      });
      log(`[MONITOR-HANDLER] 🧹 Cleanup complete, cleared active messages`);
    };

    const handleAbort = () => {
      log("XY gateway: abort signal received, stopping");
      cleanup();
      log("XY gateway stopped");
      resolve();
    };

    if (opts.abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    opts.abortSignal?.addEventListener("abort", handleAbort, { once: true });

    // Register event handlers (handlers are defined above in cleanup scope)
    wsManager.on("message", messageHandler);
    wsManager.on("connected", connectedHandler);
    wsManager.on("disconnected", disconnectedHandler);
    wsManager.on("error", errorHandler);
    opts.setStatus?.({
      running: true,
      connected: false,
      statusState: "starting",
      lastStartAt: Date.now(),
    });

    // Connect to WebSocket servers
    wsManager.connect()
      .then(() => {
        log("XY gateway: started successfully");
      })
      .catch((err) => {
        error(`XY gateway: initial connection failed: ${String(err)}`);
        opts.setStatus?.({
          connected: false,
          statusState: "reconnecting",
          lastError: String(err),
          lastEventAt: Date.now(),
        });
      });
  });
}
