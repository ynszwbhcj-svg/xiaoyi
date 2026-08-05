// Session manager for XY tool context
// Stores active session contexts that tools can access
import type { XiaoYiChannelConfig } from "../types.js";
import { logger } from "../xy-utils/logger.js";
import { configManager } from "../xy-utils/config-manager.js";

export interface SessionContext {
  config: XiaoYiChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  agentId: string;
}

// A session can have overlapping ingress while OpenClaw adopts a steer turn.
// Keep every active context so one completion cannot delete another turn's state.
const activeSessions = new Map<string, SessionContext[]>();
const registrationOrder: SessionContext[] = [];

function countActiveSessions(): number {
  return registrationOrder.length;
}

/**
 * Register a session context for tool access.
 * Should be called when starting to process a message.
 */
export function registerSession(sessionKey: string, context: SessionContext): void {
  logger.log(`[SESSION_MANAGER] 📝 Registering session: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - sessionId: ${context.sessionId}`);
  logger.log(`[SESSION_MANAGER]   - taskId: ${context.taskId}`);
  logger.log(`[SESSION_MANAGER]   - messageId: ${context.messageId}`);
  logger.log(`[SESSION_MANAGER]   - agentId: ${context.agentId}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions before: ${countActiveSessions()}`);

  const contexts = activeSessions.get(sessionKey) ?? [];
  contexts.push(context);
  activeSessions.set(sessionKey, contexts);
  registrationOrder.push(context);

  logger.log(`[SESSION_MANAGER]   - Active sessions after: ${countActiveSessions()}`);
  logger.log(`[SESSION_MANAGER]   - All session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);
}

/**
 * Unregister a session context.
 * Should be called when message processing is complete.
 */
export function unregisterSession(sessionKey: string, messageId: string): void {
  logger.log(`[SESSION_MANAGER] 🗑️  Unregistering session: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions before: ${countActiveSessions()}`);
  logger.log(`[SESSION_MANAGER]   - Session existed: ${activeSessions.has(sessionKey)}`);

  const contexts = activeSessions.get(sessionKey);
  const contextIndex = contexts?.findIndex((context) => context.messageId === messageId) ?? -1;
  const context = contextIndex >= 0 ? contexts?.splice(contextIndex, 1)[0] : undefined;
  if (contexts?.length === 0) {
    activeSessions.delete(sessionKey);
  }

  if (context) {
    const orderIndex = registrationOrder.indexOf(context);
    if (orderIndex >= 0) {
      registrationOrder.splice(orderIndex, 1);
    }
  }

  // Keep the push target while another turn in the same XiaoYi session is active.
  const sessionStillActive = context
    ? registrationOrder.some((active) => active.sessionId === context.sessionId)
    : false;
  if (context && !sessionStillActive) {
    configManager.clearSession(context.sessionId);
  }

  logger.log(`[SESSION_MANAGER]   - Deleted: ${context !== undefined}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions after: ${countActiveSessions()}`);
  logger.log(`[SESSION_MANAGER]   - Remaining session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);
}

/**
 * Get session context by sessionKey.
 * Returns null if session not found.
 */
export function getSessionContext(sessionKey: string): SessionContext | null {
  logger.log(`[SESSION_MANAGER] 🔍 Getting session by key: ${sessionKey}`);
  logger.log(`[SESSION_MANAGER]   - Active sessions: ${activeSessions.size}`);

  const contexts = activeSessions.get(sessionKey);
  const context = contexts?.[contexts.length - 1] ?? null;

  logger.log(`[SESSION_MANAGER]   - Found: ${context !== null}`);
  if (context) {
    logger.log(`[SESSION_MANAGER]   - sessionId: ${context.sessionId}`);
  }

  return context;
}

/**
 * Get the most recent session context.
 * This is a fallback for tools that don't have access to sessionKey.
 * Returns null if no sessions are active.
 */
export function getLatestSessionContext(): SessionContext | null {
  logger.log(`[SESSION_MANAGER] 🔍 Getting latest session context`);
  logger.log(`[SESSION_MANAGER]   - Active sessions count: ${countActiveSessions()}`);
  logger.log(`[SESSION_MANAGER]   - Active session keys: [${Array.from(activeSessions.keys()).join(", ")}]`);

  if (registrationOrder.length === 0) {
    logger.error(`[SESSION_MANAGER]   - ❌ No active sessions found!`);
    return null;
  }

  const latestSession = registrationOrder[registrationOrder.length - 1];

  logger.log(`[SESSION_MANAGER]   - ✅ Found latest session:`);
  logger.log(`[SESSION_MANAGER]     - sessionId: ${latestSession.sessionId}`);
  logger.log(`[SESSION_MANAGER]     - taskId: ${latestSession.taskId}`);
  logger.log(`[SESSION_MANAGER]     - messageId: ${latestSession.messageId}`);

  return latestSession;
}
