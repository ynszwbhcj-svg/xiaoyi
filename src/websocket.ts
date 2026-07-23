import WebSocket from "ws";
import { EventEmitter } from "events";
import { URL } from "url";
import { XiaoYiAuth } from "./auth.js";
import { HeartbeatManager } from "./heartbeat.js";
import {
  A2ARequestMessage,
  A2AResponseMessage,
  A2AClearMessage,
  A2ATasksCancelMessage,
  A2AJsonRpcResponse,
  A2ATaskArtifactUpdateEvent,
  A2ATaskStatusUpdateEvent,
  A2AClearContextResult,
  A2ATasksCancelResult,
  OutboundWebSocketMessage,
  WebSocketConnectionState,
  XiaoYiChannelConfig,
  InternalWebSocketConfig,
  ConnectionState,
  DEFAULT_WS_URL,
  SessionCleanupState,
} from "./types.js";

export class XiaoYiWebSocketManager extends EventEmitter {
  // ==================== Single WebSocket Connection ====================
  private ws: WebSocket | null = null;

  // ==================== Connection State ====================
  private state: ConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0
  };

  // ==================== Session Cleanup State ====================
  private sessionCleanupStateMap = new Map<string, SessionCleanupState>();
  private static readonly DEFAULT_CLEANUP_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

  // ==================== Auth & Config ====================
  private auth: XiaoYiAuth;
  private config: InternalWebSocketConfig;

  // ==================== Heartbeat ====================
  private heartbeat?: HeartbeatManager;
  private appHeartbeatInterval?: NodeJS.Timeout;

  // ==================== Reconnect ====================
  private reconnectTimeout?: NodeJS.Timeout;
  private stableConnectionTimer?: NodeJS.Timeout;
  private static readonly STABLE_CONNECTION_THRESHOLD = 10000; // 10 seconds

  // ==================== Active Tasks ====================
  private activeTasks: Map<string, any> = new Map();

  // ==================== OpenClaw Health Event Callback ====================
  private onHealthEvent?: () => void;

  constructor(config: XiaoYiChannelConfig) {
    super();

    this.config = this.resolveConfig(config);
    this.auth = new XiaoYiAuth(this.config.ak, this.config.sk, this.config.agentId);

    console.log(`[WS Manager] Initialized: ${this.config.wsUrl}`);
  }

  setHealthEventCallback(callback: () => void): void {
    this.onHealthEvent = callback;
  }

  private isWssWithIp(urlString: string): boolean {
    try {
      const url = new URL(urlString);
      if (url.protocol !== 'wss:') return false;

      const hostname = url.hostname;
      const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
      if (ipv4Regex.test(hostname)) {
        return hostname.split('.').every(octet => {
          const num = parseInt(octet, 10);
          return num >= 0 && num <= 255;
        });
      }

      if (hostname.includes('[') && hostname.includes(']')) return true;
      if (hostname.includes(':')) {
        const ipv6RegexPlain = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
        return ipv6RegexPlain.test(hostname.replace(/[\[\]]/g, ''));
      }
      return false;
    } catch {
      return false;
    }
  }

  private resolveConfig(userConfig: XiaoYiChannelConfig): InternalWebSocketConfig {
    let wsUrl = userConfig.wsUrl1 || userConfig.wsUrl;

    if (!wsUrl) {
      console.warn(`[WS Manager] wsUrl not provided, using default: ${DEFAULT_WS_URL}`);
      wsUrl = DEFAULT_WS_URL;
    }

    return {
      wsUrl,
      agentId: userConfig.agentId,
      ak: userConfig.ak,
      sk: userConfig.sk,
      enableStreaming: userConfig.enableStreaming ?? true,
      sessionCleanupTimeoutMs: userConfig.sessionCleanupTimeoutMs ?? XiaoYiWebSocketManager.DEFAULT_CLEANUP_TIMEOUT_MS,
    };
  }

  async connect(): Promise<void> {
    console.log("[WS Manager] Connecting...");
    await this.connectWs();
    this.startAppHeartbeat();
  }

  private async connectWs(): Promise<void> {
    console.log(`[WS] Connecting to ${this.config.wsUrl}...`);

    try {
      if (this.ws) {
        console.log(`[WS] Closing existing connection before reconnect`);
        if (this.heartbeat) {
          this.heartbeat.stop();
          this.heartbeat = undefined;
        }
        try {
          this.ws.removeAllListeners();
          this.ws.close();
        } catch (err) {
          console.warn(`[WS] Error closing old connection:`, err);
        }
        this.ws = null;
      }

      const authHeaders = this.auth.generateAuthHeaders();

      const skipCertVerify = this.isWssWithIp(this.config.wsUrl);
      if (skipCertVerify) {
        console.log(`[WS] WSS + IP detected, skipping certificate verification`);
      }

      this.ws = new WebSocket(this.config.wsUrl, {
        headers: authHeaders,
        rejectUnauthorized: !skipCertVerify,
      });

      this.heartbeat = new HeartbeatManager(
        this.ws,
        {
          interval: 30000,
          timeout: 10000,
          message: JSON.stringify({
            msgType: "heartbeat",
            agentId: this.config.agentId,
            timestamp: Date.now(),
          }),
        },
        () => {
          console.log(`[WS] Heartbeat timeout, reconnecting...`);
          if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            this.ws.close();
          }
        },
        "ws",
        console.log,
        console.error,
        () => {
          this.emit("heartbeat");
          this.onHealthEvent?.();
        }
      );

      this.setupWebSocketHandlers(this.ws);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 30000);
        this.ws!.once("open", () => { clearTimeout(timeout); resolve(); });
        this.ws!.once("error", (error) => { clearTimeout(timeout); reject(error); });
      });

      this.state.connected = true;
      this.state.ready = true;

      console.log(`[WS] Connected successfully`);
      this.emit("connected");

      this.scheduleStableConnectionCheck();
      this.sendInitMessage(this.ws);
      this.heartbeat.start();
      console.log(`[WS] Heartbeat started (30s interval, 10s timeout)`);

    } catch (error) {
      console.error(`[WS] Connection failed:`, error);
      this.state.connected = false;
      this.state.ready = false;
      this.emit("error", { error });
      throw error;
    }
  }

  disconnect(): void {
    console.log("[WS Manager] Disconnecting...");
    this.clearTimers();

    if (this.heartbeat) {
      this.heartbeat.stop();
      this.heartbeat = undefined;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch (err) {
        console.warn("[WS] Error during disconnect:", err);
      }
      this.ws = null;
    }

    this.state.connected = false;
    this.state.ready = false;
    this.activeTasks.clear();

    for (const [, s] of this.sessionCleanupStateMap.entries()) {
      if (s.cleanupTimeoutId) clearTimeout(s.cleanupTimeoutId);
    }
    this.sessionCleanupStateMap.clear();

    this.emit("disconnected");
    console.log("[WS Manager] Disconnect complete");
  }

  private sendInitMessage(ws: WebSocket): void {
    const initMessage: OutboundWebSocketMessage = {
      msgType: "clawd_bot_init",
      agentId: this.config.agentId,
    };
    try {
      ws.send(JSON.stringify(initMessage));
      console.log(`[WS] Sent clawd_bot_init message`);
    } catch (error) {
      console.error(`[WS] Failed to send init message:`, error);
    }
  }

  private setupWebSocketHandlers(ws: WebSocket): void {
    ws.on("open", () => {
      console.log(`[WS] WebSocket opened`);
    });

    ws.on("message", (data: WebSocket.Data) => {
      this.handleIncomingMessage(data);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[WS] WebSocket closed: ${code} ${reason.toString()}`);
      this.clearStableConnectionCheck();
      this.state.connected = false;
      this.state.ready = false;
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    ws.on("error", (error: Error) => {
      console.error(`[WS] WebSocket error:`, error);
      this.emit("error", { error });
    });

    ws.on("pong", () => {
      this.state.lastHeartbeat = Date.now();
    });
  }

  private extractSessionId(message: any): string | undefined {
    if (message.method === "message/stream") {
      return message.params?.sessionId || message.sessionId;
    }
    if (message.method === "tasks/cancel" ||
        message.method === "clearContext" ||
        message.action === "clear") {
      return message.sessionId;
    }
    return undefined;
  }

  private handleIncomingMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      console.log("\n" + "=".repeat(80));
      console.log(`[WS] Received message:`);
      console.log(JSON.stringify(message, null, 2));
      console.log("=".repeat(80) + "\n");

      if (message.agentId && message.agentId !== this.config.agentId) {
        console.warn(`[WS] Mismatched agentId: ${message.agentId}, expected: ${this.config.agentId}. Discarding.`);
        return;
      }

      const sessionId = this.extractSessionId(message);
      if (sessionId) {
        console.log(`[WS] Session: ${sessionId}`);
      }

      if (message.method === "clearContext") {
        this.handleClearContext(message);
        return;
      }

      if (message.action === "clear") {
        this.handleClearMessage(message as A2AClearMessage);
        return;
      }

      if (message.method === "tasks/cancel" || message.action === "tasks/cancel") {
        this.handleTasksCancelMessage(message);
        return;
      }

      if (this.isA2ARequestMessage(message)) {
        const sid = message.params?.sessionId || message.sessionId;
        this.activeTasks.set(message.id, { sessionId: sid, timestamp: Date.now() });
        this.emit("message", message);
      } else {
        console.warn(`[WS] Unknown message format`);
      }
    } catch (error) {
      console.error(`[WS] Failed to parse message:`, error);
      this.emit("error", { error });
    }
  }

  async sendMessage(sessionId: string, message: OutboundWebSocketMessage): Promise<void> {
    const cleanupState = this.sessionCleanupStateMap.get(sessionId);
    if (cleanupState) {
      console.log(`[SEND] Discarding message for pending cleanup session ${sessionId}`);
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not connected`);
    }

    try {
      this.ws.send(JSON.stringify(message));
      console.log(`[SEND] Message sent for session ${sessionId}, msgType=${message.msgType}`);
    } catch (error) {
      console.error(`[SEND] Failed to send:`, error);
      throw error;
    }
  }

  async sendClearContextResponse(requestId: string, sessionId: string, success: boolean = true): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not connected`);
    }

    const jsonRpcResponse: A2AJsonRpcResponse = {
      jsonrpc: "2.0",
      id: requestId,
      result: { status: { state: success ? "cleared" : "failed" } } as A2AClearContextResult,
    };

    const message: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: this.config.agentId,
      sessionId,
      taskId: requestId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`[CLEAR] Failed to send:`, error);
      throw error;
    }
  }

  async sendTasksCancelResponse(requestId: string, sessionId: string, success: boolean = true): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not connected`);
    }

    const jsonRpcResponse: A2AJsonRpcResponse = {
      jsonrpc: "2.0",
      id: requestId,
      result: { id: requestId, status: { state: success ? "canceled" : "failed" } } as A2ATasksCancelResult,
    };

    const message: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: this.config.agentId,
      sessionId,
      taskId: requestId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`[CANCEL] Failed to send:`, error);
      throw error;
    }
  }

  private handleClearContext(message: any): void {
    const sessionId = this.extractSessionId(message);
    if (!sessionId) {
      console.error(`[WS] Failed to extract sessionId from clearContext message`);
      return;
    }
    console.log(`[WS] Received clearContext for session: ${sessionId}`);
    this.sendClearContextResponse(message.id, sessionId, true)
      .catch(error => console.error(`[WS] Failed to send clearContext response:`, error));
    this.emit("clear", { sessionId, id: message.id });
    this.markSessionForCleanup(sessionId, this.config.sessionCleanupTimeoutMs ?? XiaoYiWebSocketManager.DEFAULT_CLEANUP_TIMEOUT_MS);
  }

  private handleClearMessage(message: A2AClearMessage): void {
    console.log(`[WS] Received clear message for session: ${message.sessionId}`);
    this.sendClearContextResponse(message.id, message.sessionId, true)
      .catch(error => console.error(`[WS] Failed to send clear response:`, error));
    this.emit("clear", { sessionId: message.sessionId, id: message.id });
    this.markSessionForCleanup(message.sessionId, this.config.sessionCleanupTimeoutMs ?? XiaoYiWebSocketManager.DEFAULT_CLEANUP_TIMEOUT_MS);
  }

  private handleTasksCancelMessage(message: any): void {
    const sessionId = this.extractSessionId(message);
    if (!sessionId) {
      console.error(`[WS] Failed to extract sessionId from tasks/cancel message`);
      return;
    }
    const effectiveTaskId = message.taskId || message.id;
    console.log(`[WS] Received cancel: session=${sessionId}, task=${effectiveTaskId}`);
    this.sendTasksCancelResponse(message.id, sessionId, true)
      .catch(error => console.error(`[WS] Failed to send cancel response:`, error));
    this.emit("cancel", { sessionId, taskId: effectiveTaskId, id: message.id });
    this.activeTasks.delete(effectiveTaskId);
  }

  private isA2ARequestMessage(data: any): data is A2ARequestMessage {
    return data &&
      typeof data.agentId === "string" &&
      data.jsonrpc === "2.0" &&
      typeof data.id === "string" &&
      data.method === "message/stream" &&
      data.params &&
      typeof data.params.id === "string" &&
      (typeof data.params.sessionId === "string" || typeof data.sessionId === "string") &&
      data.params.message &&
      typeof data.params.message.role === "string" &&
      Array.isArray(data.params.message.parts);
  }

  isReady(): boolean {
    return this.state.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  getState(): WebSocketConnectionState {
    return {
      connected: this.state.connected,
      authenticated: this.state.connected,
      lastHeartbeat: this.state.lastHeartbeat,
      lastAppHeartbeat: 0,
      reconnectAttempts: this.state.reconnectAttempts,
      maxReconnectAttempts: 50,
    };
  }

  getActiveTasks(): Map<string, any> {
    return new Map(this.activeTasks);
  }

  removeActiveTask(taskId: string): void {
    this.activeTasks.delete(taskId);
  }

  // ==================== Reconnect ====================

  private scheduleReconnect(): void {
    if (this.state.reconnectAttempts >= 50) {
      console.error(`[WS] Max reconnection attempts reached`);
      this.emit("maxReconnectAttemptsReached");
      return;
    }

    const delay = Math.min(2000 * Math.pow(2, this.state.reconnectAttempts), 60000);
    this.state.reconnectAttempts++;

    console.log(`[WS] Scheduling reconnect attempt ${this.state.reconnectAttempts}/50 in ${delay}ms`);

    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connectWs();
        console.log(`[WS] Reconnected successfully`);
      } catch (error) {
        console.error(`[WS] Reconnection failed:`, error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearTimers(): void {
    if (this.appHeartbeatInterval) {
      clearInterval(this.appHeartbeatInterval);
      this.appHeartbeatInterval = undefined;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.clearStableConnectionCheck();
  }

  private scheduleStableConnectionCheck(): void {
    this.stableConnectionTimer = setTimeout(() => {
      if (this.state.connected) {
        console.log(`[WS] Connection stable for ${XiaoYiWebSocketManager.STABLE_CONNECTION_THRESHOLD}ms, resetting reconnect counter`);
        this.state.reconnectAttempts = 0;
      }
    }, XiaoYiWebSocketManager.STABLE_CONNECTION_THRESHOLD);
  }

  private clearStableConnectionCheck(): void {
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = undefined;
    }
  }

  // ==================== App Heartbeat ====================

  private startAppHeartbeat(): void {
    this.appHeartbeatInterval = setInterval(() => {
      const heartbeatMessage: OutboundWebSocketMessage = {
        msgType: "heartbeat",
        agentId: this.config.agentId,
      };
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify(heartbeatMessage));
        } catch (error) {
          console.error('[WS] Failed to send app heartbeat:', error);
        }
      }
    }, 20000);
  }

  // ==================== Session Cleanup ====================

  private markSessionForCleanup(sessionId: string, timeoutMs: number): void {
    const existingState = this.sessionCleanupStateMap.get(sessionId);
    if (existingState) {
      if (existingState.cleanupTimeoutId) clearTimeout(existingState.cleanupTimeoutId);
      console.log(`[CLEANUP] Session ${sessionId} already pending cleanup, resetting timeout`);
    }

    const newState: SessionCleanupState = {
      sessionId,
      markedForCleanupAt: Date.now(),
      reason: 'user_cleared',
    };

    const timeoutId = setTimeout(() => {
      console.log(`[CLEANUP] Timeout reached for session ${sessionId}, forcing cleanup`);
      this.forceCleanupSession(sessionId);
    }, timeoutMs);

    newState.cleanupTimeoutId = timeoutId;
    this.sessionCleanupStateMap.set(sessionId, newState);
    console.log(`[CLEANUP] Session ${sessionId} marked for cleanup (timeout: ${timeoutMs}ms)`);
  }

  forceCleanupSession(sessionId: string): void {
    const state = this.sessionCleanupStateMap.get(sessionId);
    if (!state) return;

    if (state.cleanupTimeoutId) clearTimeout(state.cleanupTimeoutId);
    this.sessionCleanupStateMap.delete(sessionId);
    console.log(`[CLEANUP] Session ${sessionId} cleanup completed`);
  }

  isSessionPendingCleanup(sessionId: string): boolean {
    return this.sessionCleanupStateMap.has(sessionId);
  }

  getSessionCleanupState(sessionId: string): SessionCleanupState | undefined {
    return this.sessionCleanupStateMap.get(sessionId);
  }

  updateAccumulatedTextForCleanup(sessionId: string, text: string): void {
    const state = this.sessionCleanupStateMap.get(sessionId);
    if (state) state.accumulatedText = text;
  }
}
