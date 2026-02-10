import { XiaoYiWebSocketManager } from "./websocket";
import { XiaoYiChannelConfig } from "./types";

/**
 * Timeout configuration
 */
export interface TimeoutConfig {
  enabled: boolean;
  duration: number; // milliseconds
  message: string; // Timeout message to send to user
}

/**
 * Default timeout configuration
 */
const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  enabled: true,
  duration: 60000, // 60 seconds
  message: "任务还在处理中，请稍后回来查看",
};

/**
 * Runtime state for XiaoYi channel
 * Manages single WebSocket connection (single account mode)
 */
export class XiaoYiRuntime {
  private connection: XiaoYiWebSocketManager | null = null;
  private pluginRuntime: any = null; // Store PluginRuntime from OpenClaw
  private config: XiaoYiChannelConfig | null = null;
  private sessionToTaskIdMap: Map<string, string> = new Map(); // Map sessionId to taskId
  private instanceId: string; // Track instance identity

  // Timeout management
  private sessionTimeoutMap: Map<string, NodeJS.Timeout> = new Map();
  private sessionTimeoutSent: Set<string> = new Set();
  private timeoutConfig: TimeoutConfig = DEFAULT_TIMEOUT_CONFIG;

  // AbortController management for canceling agent runs
  private sessionAbortControllerMap: Map<string, AbortController> = new Map();

  constructor() {
    this.instanceId = `runtime_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`XiaoYi: Created new runtime instance: ${this.instanceId}`);
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Set OpenClaw PluginRuntime (from api.runtime in register())
   */
  setPluginRuntime(runtime: any): void {
    console.log(`XiaoYi: [${this.instanceId}] Setting PluginRuntime`);
    this.pluginRuntime = runtime;
  }

  /**
   * Get OpenClaw PluginRuntime
   */
  getPluginRuntime(): any {
    return this.pluginRuntime;
  }

  /**
   * Start connection (single account mode)
   */
  async start(config: XiaoYiChannelConfig): Promise<void> {
    if (this.connection) {
      console.log("XiaoYi channel already connected");
      return;
    }

    this.config = config;
    const manager = new XiaoYiWebSocketManager(config);

    // Setup basic event handlers (message handling is done in channel.ts)
    manager.on("error", (error) => {
      console.error("XiaoYi channel error:", error);
    });

    manager.on("disconnected", () => {
      console.log("XiaoYi channel disconnected");
    });

    manager.on("authenticated", () => {
      console.log("XiaoYi channel authenticated");
    });

    manager.on("maxReconnectAttemptsReached", (serverId: string) => {
      console.error(`XiaoYi channel ${serverId} max reconnect attempts reached`);

      // Check if the other server is still connected and ready
      const otherServerId = serverId === 'server1' ? 'server2' : 'server1';
      const serverStates = manager.getServerStates();
      const otherServerState = otherServerId === 'server1' ? serverStates.server1 : serverStates.server2;

      if (otherServerState?.connected && otherServerState?.ready) {
        console.warn(`[${otherServerId}] is still connected and ready, continuing in single-server mode`);
        console.warn(`System will continue running with ${otherServerId} only`);
        // Don't stop, continue with the other server
        return;
      }

      // Only stop when both servers have failed
      console.error("Both servers have reached max reconnect attempts, stopping connection");
      console.error(`Server1: ${serverStates.server1.connected ? 'connected' : 'disconnected'}, Server2: ${serverStates.server2.connected ? 'connected' : 'disconnected'}`);
      this.stop();
    });

    // Connect
    await manager.connect();
    this.connection = manager;

    console.log("XiaoYi channel started");
  }

  /**
   * Stop connection
   */
  stop(): void {
    if (this.connection) {
      this.connection.disconnect();
      this.connection = null;
      console.log("XiaoYi channel stopped");
    }
    // Clear session mappings
    this.sessionToTaskIdMap.clear();
    // Clear all timeouts
    this.clearAllTimeouts();
    // Clear all abort controllers
    this.clearAllAbortControllers();
  }

  /**
   * Set timeout configuration
   */
  setTimeoutConfig(config: Partial<TimeoutConfig>): void {
    this.timeoutConfig = { ...this.timeoutConfig, ...config };
    console.log(`XiaoYi: Timeout config updated:`, this.timeoutConfig);
  }

  /**
   * Get timeout configuration
   */
  getTimeoutConfig(): TimeoutConfig {
    return { ...this.timeoutConfig };
  }

  /**
   * Set timeout for a session
   * @param sessionId - Session ID
   * @param callback - Function to call when timeout occurs
   * @returns The timeout ID (for cancellation)
   */
  setTimeoutForSession(sessionId: string, callback: () => void): NodeJS.Timeout | undefined {
    if (!this.timeoutConfig.enabled) {
      console.log(`[TIMEOUT] Timeout disabled, skipping for session ${sessionId}`);
      return undefined;
    }

    // Clear existing timeout AND timeout flag if any (reuse session scenario)
    const hadExistingTimeout = this.sessionTimeoutMap.has(sessionId);
    const hadSentTimeout = this.sessionTimeoutSent.has(sessionId);

    this.clearSessionTimeout(sessionId);

    // Also clear the timeout sent flag to allow this session to timeout again
    if (hadSentTimeout) {
      this.sessionTimeoutSent.delete(sessionId);
      console.log(`[TIMEOUT] Previous timeout flag cleared for session ${sessionId} (session reuse)`);
    }

    const timeoutId = setTimeout(() => {
      console.log(`[TIMEOUT] Timeout triggered for session ${sessionId}`);
      this.sessionTimeoutMap.delete(sessionId);
      this.sessionTimeoutSent.add(sessionId);
      callback();
    }, this.timeoutConfig.duration);

    this.sessionTimeoutMap.set(sessionId, timeoutId);
    const logSuffix = hadExistingTimeout ? " (replacing existing timeout)" : "";
    console.log(`[TIMEOUT] ${this.timeoutConfig.duration}ms timeout started for session ${sessionId}${logSuffix}`);

    return timeoutId;
  }

  /**
   * Clear timeout for a session
   * @param sessionId - Session ID
   */
  clearSessionTimeout(sessionId: string): void {
    const timeoutId = this.sessionTimeoutMap.get(sessionId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.sessionTimeoutMap.delete(sessionId);
      console.log(`[TIMEOUT] Timeout cleared for session ${sessionId}`);
    }
  }

  /**
   * Check if timeout has been sent for a session
   * @param sessionId - Session ID
   */
  isSessionTimeout(sessionId: string): boolean {
    return this.sessionTimeoutSent.has(sessionId);
  }

  /**
   * Mark session as completed (clear timeout and timeout flag)
   * @param sessionId - Session ID
   */
  markSessionCompleted(sessionId: string): void {
    this.clearSessionTimeout(sessionId);
    this.sessionTimeoutSent.delete(sessionId);
    console.log(`[TIMEOUT] Session ${sessionId} marked as completed`);
  }

  /**
   * Clear all timeouts
   */
  clearAllTimeouts(): void {
    for (const [sessionId, timeoutId] of this.sessionTimeoutMap.entries()) {
      clearTimeout(timeoutId);
    }
    this.sessionTimeoutMap.clear();
    this.sessionTimeoutSent.clear();
    console.log("[TIMEOUT] All timeouts cleared");
  }

  /**
   * Get WebSocket manager
   */
  getConnection(): XiaoYiWebSocketManager | null {
    return this.connection;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connection ? this.connection.isReady() : false;
  }

  /**
   * Get configuration
   */
  getConfig(): XiaoYiChannelConfig | null {
    return this.config;
  }

  /**
   * Set taskId for a session
   */
  setTaskIdForSession(sessionId: string, taskId: string): void {
    this.sessionToTaskIdMap.set(sessionId, taskId);
  }

  /**
   * Get taskId for a session
   */
  getTaskIdForSession(sessionId: string): string | undefined {
    return this.sessionToTaskIdMap.get(sessionId);
  }

  /**
   * Clear taskId for a session
   */
  clearTaskIdForSession(sessionId: string): void {
    this.sessionToTaskIdMap.delete(sessionId);
  }

  /**
   * Create and register an AbortController for a session
   * @param sessionId - Session ID
   * @returns The AbortController and its signal
   */
  createAbortControllerForSession(sessionId: string): { controller: AbortController; signal: AbortSignal } {
    // Abort any existing controller for this session
    this.abortSession(sessionId);

    const controller = new AbortController();
    this.sessionAbortControllerMap.set(sessionId, controller);
    console.log(`[ABORT] Created AbortController for session ${sessionId}`);

    return { controller, signal: controller.signal };
  }

  /**
   * Abort a session's agent run
   * @param sessionId - Session ID
   * @returns true if a controller was found and aborted, false otherwise
   */
  abortSession(sessionId: string): boolean {
    const controller = this.sessionAbortControllerMap.get(sessionId);
    if (controller) {
      console.log(`[ABORT] Aborting session ${sessionId}`);
      controller.abort();
      this.sessionAbortControllerMap.delete(sessionId);
      return true;
    }
    console.log(`[ABORT] No AbortController found for session ${sessionId}`);
    return false;
  }

  /**
   * Check if a session has been aborted
   * @param sessionId - Session ID
   * @returns true if the session's abort signal was triggered
   */
  isSessionAborted(sessionId: string): boolean {
    const controller = this.sessionAbortControllerMap.get(sessionId);
    return controller ? controller.signal.aborted : false;
  }

  /**
   * Clear the AbortController for a session (call when agent completes successfully)
   * @param sessionId - Session ID
   */
  clearAbortControllerForSession(sessionId: string): void {
    const controller = this.sessionAbortControllerMap.get(sessionId);
    if (controller) {
      this.sessionAbortControllerMap.delete(sessionId);
      console.log(`[ABORT] Cleared AbortController for session ${sessionId}`);
    }
  }

  /**
   * Clear all AbortControllers
   */
  clearAllAbortControllers(): void {
    this.sessionAbortControllerMap.clear();
    console.log("[ABORT] All AbortControllers cleared");
  }
}

// Global runtime instance - use global object to survive module reloads
// CRITICAL: Use string key instead of Symbol to ensure consistency across module reloads
const GLOBAL_KEY = '__xiaoyi_runtime_instance__';

export function getXiaoYiRuntime(): XiaoYiRuntime {
  const g = global as any;
  if (!g[GLOBAL_KEY]) {
    console.log("XiaoYi: Creating NEW runtime instance (global storage)");
    g[GLOBAL_KEY] = new XiaoYiRuntime();
  } else {
    console.log(`XiaoYi: Reusing EXISTING runtime instance: ${g[GLOBAL_KEY].getInstanceId()}`);
  }
  return g[GLOBAL_KEY];
}

export function setXiaoYiRuntime(runtime: any): void {
  getXiaoYiRuntime().setPluginRuntime(runtime);
}
