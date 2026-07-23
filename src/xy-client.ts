// WebSocket client cache management
// Adapted for xiaoyi - uses xiaoyi's WebSocket manager with aksk auth
import { XiaoYiWebSocketManager } from "./websocket.js";
import type { XiaoYiChannelConfig } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk";

// Runtime reference for logging
let runtime: RuntimeEnv | undefined;

/**
 * Set the runtime for logging in client module.
 */
export function setClientRuntime(rt: RuntimeEnv | undefined): void {
  runtime = rt;
}

/**
 * Global cache for WebSocket managers.
 * Key format: `${ak}-${agentId}` (using xiaoyi's aksk auth)
 */
const wsManagerCache = new Map<string, XiaoYiWebSocketManager>();

/**
 * Get or create a WebSocket manager for the given configuration.
 * Reuses existing managers if config matches.
 * Adapted for xiaoyi - uses aksk instead of apiKey/uid
 */
export function getXYWebSocketManager(config: XiaoYiChannelConfig): XiaoYiWebSocketManager {
  const cacheKey = `${config.ak}-${config.agentId}`;
  let cached = wsManagerCache.get(cacheKey);

  if (cached) {
    const log = runtime?.log ?? console.log;
    log(`[WS-MANAGER-CACHE] ✅ Reusing cached WebSocket manager: ${cacheKey}, total managers: ${wsManagerCache.size}`);
    return cached;
  }

  // Create new manager with xiaoyi's config (aksk auth)
  const log = runtime?.log ?? console.log;
  log(`[WS-MANAGER-CACHE] 🆕 Creating new WebSocket manager: ${cacheKey}, total managers before: ${wsManagerCache.size}`);
  cached = new XiaoYiWebSocketManager(config);
  wsManagerCache.set(cacheKey, cached);
  log(`[WS-MANAGER-CACHE] 📊 Total managers after creation: ${wsManagerCache.size}`);

  return cached;
}

/**
 * Remove a specific WebSocket manager from cache.
 * Disconnects the manager and removes it from the cache.
 */
export function removeXYWebSocketManager(config: XiaoYiChannelConfig): void {
  const cacheKey = `${config.ak}-${config.agentId}`;
  const manager = wsManagerCache.get(cacheKey);

  if (manager) {
    console.log(`🗑️  [WS-MANAGER-CACHE] Removing manager from cache: ${cacheKey}`);
    manager.disconnect();
    wsManagerCache.delete(cacheKey);
    console.log(`🗑️  [WS-MANAGER-CACHE] Manager removed, remaining managers: ${wsManagerCache.size}`);
  } else {
    console.log(`⚠️  [WS-MANAGER-CACHE] Manager not found in cache: ${cacheKey}`);
  }
}

/**
 * Clear all cached WebSocket managers.
 */
export function clearXYWebSocketManagers(): void {
  const log = runtime?.log ?? console.log;
  log("Clearing all WebSocket manager caches");
  for (const manager of wsManagerCache.values()) {
    manager.disconnect();
  }
  wsManagerCache.clear();
}

/**
 * Get the number of cached managers.
 */
export function getCachedManagerCount(): number {
  return wsManagerCache.size;
}
