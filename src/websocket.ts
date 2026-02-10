import WebSocket from "ws";
import { EventEmitter } from "events";
import { URL } from "url";
import { XiaoYiAuth } from "./auth";
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
  ServerId,
  ServerConnectionState,
  DEFAULT_WS_URL_1,
  DEFAULT_WS_URL_2,
} from "./types";

export class XiaoYiWebSocketManager extends EventEmitter {
  // ==================== Dual WebSocket Connections ====================
  private ws1: WebSocket | null = null;
  private ws2: WebSocket | null = null;

  // ==================== Dual Server States ====================
  private state1: ServerConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0
  };

  private state2: ServerConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0
  };

  // ==================== Session → Server Mapping ====================
  private sessionServerMap = new Map<string, ServerId>();

  // ==================== Auth & Config ====================
  private auth: XiaoYiAuth;
  private config: InternalWebSocketConfig;

  // ==================== Heartbeat Timers ====================
  private heartbeatTimeout1?: NodeJS.Timeout;
  private heartbeatTimeout2?: NodeJS.Timeout;
  private appHeartbeatInterval?: NodeJS.Timeout;

  // ==================== Reconnect Timers ====================
  private reconnectTimeout1?: NodeJS.Timeout;
  private reconnectTimeout2?: NodeJS.Timeout;

  // ==================== Connection Stability Timers ====================
  // Track stable connections before resetting reconnect counter
  private stableConnectionTimer1?: NodeJS.Timeout;
  private stableConnectionTimer2?: NodeJS.Timeout;
  private static readonly STABLE_CONNECTION_THRESHOLD = 10000; // 10 seconds

  // ==================== Active Tasks ====================
  private activeTasks: Map<string, any> = new Map();

  constructor(config: XiaoYiChannelConfig) {
    super();

    // Resolve configuration with defaults and backward compatibility
    this.config = this.resolveConfig(config);
    this.auth = new XiaoYiAuth(this.config.ak, this.config.sk, this.config.agentId);

    console.log(`[WS Manager] Initialized with dual server:`);
    console.log(`  Server 1: ${this.config.wsUrl1}`);
    console.log(`  Server 2: ${this.config.wsUrl2}`);
  }

  /**
   * Check if URL is wss + IP format (skip certificate verification)
   */
  private isWssWithIp(urlString: string): boolean {
    try {
      const url = new URL(urlString);

      // Check if protocol is wss
      if (url.protocol !== 'wss:') {
        return false;
      }

      const hostname = url.hostname;

      // Check for IPv4 address (e.g., 192.168.1.1)
      const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
      if (ipv4Regex.test(hostname)) {
        // Validate each octet is 0-255
        const octets = hostname.split('.');
        return octets.every(octet => {
          const num = parseInt(octet, 10);
          return num >= 0 && num <= 255;
        });
      }

      // Check for IPv6 address (e.g., [::1] or 2001:db8::1)
      // IPv6 in URL might be wrapped in brackets
      const ipv6Regex = /^[\[::0-9a-fA-F]+$/;
      const ipv6WithoutBrackets = hostname.replace(/[\[\]]/g, '');

      // Simple check for IPv6: contains colons and valid hex characters
      if (hostname.includes('[') && hostname.includes(']')) {
        return ipv6Regex.test(hostname);
      }

      // Check for plain IPv6 format
      if (hostname.includes(':')) {
        const ipv6RegexPlain = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
        return ipv6RegexPlain.test(ipv6WithoutBrackets);
      }

      return false;
    } catch (error) {
      console.warn(`[WS Manager] Invalid URL format: ${urlString}`);
      return false;
    }
  }

  /**
   * Resolve configuration with defaults and backward compatibility
   */
  private resolveConfig(userConfig: XiaoYiChannelConfig): InternalWebSocketConfig {
    // Backward compatibility: if wsUrl is provided but wsUrl1/wsUrl2 are not,
    // use wsUrl for server1 and default for server2
    let wsUrl1 = userConfig.wsUrl1;
    let wsUrl2 = userConfig.wsUrl2;

    if (!wsUrl1 && userConfig.wsUrl) {
      wsUrl1 = userConfig.wsUrl;
    }

    // Apply defaults if not provided
    if (!wsUrl1) {
      console.warn(`[WS Manager] wsUrl1 not provided, using default: ${DEFAULT_WS_URL_1}`);
      wsUrl1 = DEFAULT_WS_URL_1;
    }

    if (!wsUrl2) {
      console.warn(`[WS Manager] wsUrl2 not provided, using default: ${DEFAULT_WS_URL_2}`);
      wsUrl2 = DEFAULT_WS_URL_2;
    }

    return {
      wsUrl1,
      wsUrl2,
      agentId: userConfig.agentId,
      ak: userConfig.ak,
      sk: userConfig.sk,
      enableStreaming: userConfig.enableStreaming ?? true,
    };
  }

  /**
   * Connect to both WebSocket servers
   */
  async connect(): Promise<void> {
    console.log("[WS Manager] Connecting to both servers...");

    const results = await Promise.allSettled([
      this.connectToServer1(),
      this.connectToServer2(),
    ]);

    // Check if at least one connection succeeded
    const server1Success = results[0].status === 'fulfilled';
    const server2Success = results[1].status === 'fulfilled';

    if (!server1Success && !server2Success) {
      console.error("[WS Manager] Failed to connect to both servers");
      throw new Error("Failed to connect to both servers");
    }

    console.log(`[WS Manager] Connection results: Server1=${server1Success}, Server2=${server2Success}`);

    // Start application-level heartbeat (only if at least one connection is ready)
    if (this.state1.connected || this.state2.connected) {
      this.startAppHeartbeat();
    }
  }

  /**
   * Connect to server 1
   */
  private async connectToServer1(): Promise<void> {
    console.log(`[Server1] Connecting to ${this.config.wsUrl1}...`);

    try {
      const authHeaders = this.auth.generateAuthHeaders();

      // Check if URL is wss + IP format, skip certificate verification
      const skipCertVerify = this.isWssWithIp(this.config.wsUrl1);
      if (skipCertVerify) {
        console.log(`[Server1] WSS + IP detected, skipping certificate verification`);
      }

      this.ws1 = new WebSocket(this.config.wsUrl1, {
        headers: authHeaders,
        rejectUnauthorized: !skipCertVerify,
      });

      this.setupWebSocketHandlers(this.ws1, 'server1');

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 30000);

        this.ws1!.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws1!.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.state1.connected = true;
      this.state1.ready = true;

      console.log(`[Server1] Connected successfully`);
      this.emit("connected", "server1");

      // Schedule connection stability check before resetting reconnect counter
      this.scheduleStableConnectionCheck('server1');

      // Send init message
      this.sendInitMessage(this.ws1, 'server1');

      // Start protocol heartbeat
      this.startProtocolHeartbeat('server1');

    } catch (error) {
      console.error(`[Server1] Connection failed:`, error);
      this.state1.connected = false;
      this.state1.ready = false;
      this.emit("error", { serverId: 'server1', error });
      throw error;
    }
  }

  /**
   * Connect to server 2
   */
  private async connectToServer2(): Promise<void> {
    console.log(`[Server2] Connecting to ${this.config.wsUrl2}...`);

    try {
      const authHeaders = this.auth.generateAuthHeaders();

      // Check if URL is wss + IP format, skip certificate verification
      const skipCertVerify = this.isWssWithIp(this.config.wsUrl2);
      if (skipCertVerify) {
        console.log(`[Server2] WSS + IP detected, skipping certificate verification`);
      }

      this.ws2 = new WebSocket(this.config.wsUrl2, {
        headers: authHeaders,
        rejectUnauthorized: !skipCertVerify,
      });

      this.setupWebSocketHandlers(this.ws2, 'server2');

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Connection timeout")), 30000);

        this.ws2!.once("open", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws2!.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      this.state2.connected = true;
      this.state2.ready = true;

      console.log(`[Server2] Connected successfully`);
      this.emit("connected", "server2");

      // Schedule connection stability check before resetting reconnect counter
      this.scheduleStableConnectionCheck('server2');

      // Send init message
      this.sendInitMessage(this.ws2, 'server2');

      // Start protocol heartbeat
      this.startProtocolHeartbeat('server2');

    } catch (error) {
      console.error(`[Server2] Connection failed:`, error);
      this.state2.connected = false;
      this.state2.ready = false;
      this.emit("error", { serverId: 'server2', error });
      throw error;
    }
  }

  /**
   * Disconnect from all servers
   */
  disconnect(): void {
    console.log("[WS Manager] Disconnecting from all servers...");

    this.clearTimers();

    if (this.ws1) {
      this.ws1.close();
      this.ws1 = null;
    }

    if (this.ws2) {
      this.ws2.close();
      this.ws2 = null;
    }

    this.state1.connected = false;
    this.state1.ready = false;
    this.state2.connected = false;
    this.state2.ready = false;
    this.sessionServerMap.clear();
    this.activeTasks.clear();

    this.emit("disconnected");
  }

  /**
   * Send init message to specific server
   */
  private sendInitMessage(ws: WebSocket, serverId: ServerId): void {
    const initMessage: OutboundWebSocketMessage = {
      msgType: "clawd_bot_init",
      agentId: this.config.agentId,
    };

    try {
      ws.send(JSON.stringify(initMessage));
      console.log(`[${serverId}] Sent clawd_bot_init message`);
    } catch (error) {
      console.error(`[${serverId}] Failed to send init message:`, error);
    }
  }

  /**
   * Setup WebSocket event handlers for specific server
   */
  private setupWebSocketHandlers(ws: WebSocket, serverId: ServerId): void {
    ws.on("open", () => {
      console.log(`[${serverId}] WebSocket opened`);
    });

    ws.on("message", (data: WebSocket.Data) => {
      this.handleIncomingMessage(data, serverId);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[${serverId}] WebSocket closed: ${code} ${reason.toString()}`);

      // Clear stable connection timer - connection was not stable
      this.clearStableConnectionCheck(serverId);

      if (serverId === 'server1') {
        this.state1.connected = false;
        this.state1.ready = false;
        this.clearProtocolHeartbeat('server1');
      } else {
        this.state2.connected = false;
        this.state2.ready = false;
        this.clearProtocolHeartbeat('server2');
      }

      this.emit("disconnected", serverId);
      this.scheduleReconnect(serverId);
    });

    ws.on("error", (error: Error) => {
      console.error(`[${serverId}] WebSocket error:`, error);
      this.emit("error", { serverId, error });
    });

    ws.on("pong", () => {
      if (serverId === 'server1') {
        this.state1.lastHeartbeat = Date.now();
      } else {
        this.state2.lastHeartbeat = Date.now();
      }
    });
  }

  /**
   * Extract sessionId from message based on method type
   * Different methods have sessionId in different locations:
   * - message/stream: sessionId in params, fallback to top-level sessionId
   * - tasks/cancel: sessionId at top level
   * - clearContext: sessionId at top level
   */
  private extractSessionId(message: any): string | undefined {
    // For message/stream, prioritize params.sessionId, fallback to top-level sessionId
    if (message.method === "message/stream") {
      return message.params?.sessionId || message.sessionId;
    }

    // For tasks/cancel and clearContext, sessionId is at top level
    if (message.method === "tasks/cancel" ||
        message.method === "clearContext" ||
        message.action === "clear") {
      return message.sessionId;
    }

    return undefined;
  }

  /**
   * Handle incoming message from specific server
   */
  private handleIncomingMessage(data: WebSocket.Data, sourceServer: ServerId): void {
    try {
      const message = JSON.parse(data.toString());

      // Log received message
      console.log("\n" + "=".repeat(80));
      console.log(`[${sourceServer}] Received message:`);
      console.log(JSON.stringify(message, null, 2));
      console.log("=".repeat(80) + "\n");

      // Validate agentId
      if (message.agentId && message.agentId !== this.config.agentId) {
        console.warn(`[${sourceServer}] Mismatched agentId: ${message.agentId}, expected: ${this.config.agentId}. Discarding.`);
        return;
      }

      // Extract sessionId based on method type
      const sessionId = this.extractSessionId(message);

      // Record session → server mapping
      if (sessionId) {
        this.sessionServerMap.set(sessionId, sourceServer);
        console.log(`[MAP] Session ${sessionId} -> ${sourceServer}`);
      }

      // Handle special messages (clearContext, tasks/cancel)
      if (message.method === "clearContext") {
        this.handleClearContext(message, sourceServer);
        return;
      }

      if (message.action === "clear") {
        this.handleClearMessage(message as A2AClearMessage, sourceServer);
        return;
      }

      if (message.method === "tasks/cancel" || message.action === "tasks/cancel") {
        this.handleTasksCancelMessage(message, sourceServer);
        return;
      }

      // Handle regular A2A request
      if (this.isA2ARequestMessage(message)) {
        // Store task for potential cancellation (support params.sessionId or top-level sessionId)
        const sessionId = message.params?.sessionId || message.sessionId;
        this.activeTasks.set(message.id, {
          sessionId: sessionId,
          timestamp: Date.now(),
        });

        // Emit with server info
        this.emit("message", message);
      } else {
        console.warn(`[${sourceServer}] Unknown message format`);
      }

    } catch (error) {
      console.error(`[${sourceServer}] Failed to parse message:`, error);
      this.emit("error", { serverId: sourceServer, error });
    }
  }

  /**
   * Send A2A response message with automatic routing
   */
  async sendResponse(
    response: A2AResponseMessage,
    taskId: string,
    sessionId: string,
    isFinal: boolean = true,
    append: boolean = false
  ): Promise<void> {
    // Find which server this session belongs to
    const targetServer = this.sessionServerMap.get(sessionId);

    if (!targetServer) {
      console.error(`[ROUTE] Unknown server for session ${sessionId}`);
      throw new Error(`Cannot route response: unknown session ${sessionId}`);
    }

    // Get the corresponding WebSocket connection
    const ws = targetServer === 'server1' ? this.ws1 : this.ws2;
    const state = targetServer === 'server1' ? this.state1 : this.state2;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`[ROUTE] ${targetServer} not connected for session ${sessionId}`);
      throw new Error(`${targetServer} is not available`);
    }

    // Convert to JSON-RPC format
    const jsonRpcResponse = this.convertToJsonRpcFormat(response, taskId, isFinal, append);

    const message: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: this.config.agentId,
      sessionId: sessionId,
      taskId: taskId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    try {
      ws.send(JSON.stringify(message));
      console.log(`[ROUTE] Response sent to ${targetServer} for session ${sessionId} (isFinal=${isFinal}, append=${append})`);
    } catch (error) {
      console.error(`[ROUTE] Failed to send to ${targetServer}:`, error);
      throw error;
    }
  }

  /**
   * Send clear context response to specific server
   */
  async sendClearContextResponse(
    requestId: string,
    sessionId: string,
    success: boolean = true,
    targetServer?: ServerId
  ): Promise<void> {
    const serverId = targetServer || this.sessionServerMap.get(sessionId);

    if (!serverId) {
      console.error(`[CLEAR] Unknown server for session ${sessionId}`);
      throw new Error(`Cannot send clear response: unknown session ${sessionId}`);
    }

    const ws = serverId === 'server1' ? this.ws1 : this.ws2;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`[CLEAR] ${serverId} not connected`);
      throw new Error(`${serverId} is not available`);
    }

    const jsonRpcResponse: A2AJsonRpcResponse = {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        status: {
          state: success ? "cleared" : "failed"
        }
      } as A2AClearContextResult,
    };

    const message: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: this.config.agentId,
      sessionId: sessionId,
      taskId: requestId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    console.log(`\n[CLEAR] Sending clearContext response to ${serverId}:`);
    console.log(`  sessionId: ${sessionId}`);
    console.log(`  requestId: ${requestId}`);
    console.log(`  success: ${success}\n`);

    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`[CLEAR] Failed to send to ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Send status update (for intermediate status messages, e.g., timeout warnings)
   * This uses "status-update" event type which keeps the conversation active
   */
  async sendStatusUpdate(
    taskId: string,
    sessionId: string,
    message: string,
    targetServer?: ServerId
  ): Promise<void> {
    const serverId = targetServer || this.sessionServerMap.get(sessionId);

    if (!serverId) {
      console.error(`[STATUS] Unknown server for session ${sessionId}`);
      throw new Error(`Cannot send status update: unknown session ${sessionId}`);
    }

    const ws = serverId === 'server1' ? this.ws1 : this.ws2;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`[STATUS] ${serverId} not connected`);
      throw new Error(`${serverId} is not available`);
    }

    // Create unique ID for this status update
    const messageId = `status_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const jsonRpcResponse: A2AJsonRpcResponse = {
      jsonrpc: "2.0",
      id: messageId,
      result: {
        taskId: taskId,
        kind: "status-update",
        final: false, // IMPORTANT: Not final, keeps conversation active
        status: {
          message: {
            role: "agent",
            parts: [
              {
                kind: "text",
                text: message,
              },
            ],
          },
          state: "working", // Indicates task is still being processed
        },
      } as A2ATaskStatusUpdateEvent,
    };

    const outboundMessage: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: this.config.agentId,
      sessionId: sessionId,
      taskId: taskId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    console.log(`[STATUS] Sending status update to ${serverId}:`);
    console.log(`  sessionId: ${sessionId}`);
    console.log(`  taskId: ${taskId}`);
    console.log(`  message: ${message}`);
    console.log(`  final: false, state: working\n`);

    try {
      ws.send(JSON.stringify(outboundMessage));
    } catch (error) {
      console.error(`[STATUS] Failed to send to ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Send tasks cancel response to specific server
   */
  async sendTasksCancelResponse(
    requestId: string,
    sessionId: string,
    success: boolean = true,
    targetServer?: ServerId
  ): Promise<void> {
    const serverId = targetServer || this.sessionServerMap.get(sessionId);

    if (!serverId) {
      console.error(`[CANCEL] Unknown server for session ${sessionId}`);
      throw new Error(`Cannot send cancel response: unknown session ${sessionId}`);
    }

    const ws = serverId === 'server1' ? this.ws1 : this.ws2;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`[CANCEL] ${serverId} not connected`);
      throw new Error(`${serverId} is not available`);
    }

    const jsonRpcResponse: A2AJsonRpcResponse = {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        id: requestId,
        status: {
          state: success ? "canceled" : "failed"
        }
      } as A2ATasksCancelResult,
    };

    const message: OutboundWebSocketMessage = {
      msgType: "agent_response",
      agentId: this.config.agentId,
      sessionId: sessionId,
      taskId: requestId,
      msgDetail: JSON.stringify(jsonRpcResponse),
    };

    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`[CANCEL] Failed to send to ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Handle clearContext method
   */
  private handleClearContext(message: any, sourceServer: ServerId): void {
    const sessionId = this.extractSessionId(message);
    if (!sessionId) {
      console.error(`[${sourceServer}] Failed to extract sessionId from clearContext message`);
      return;
    }

    console.log(`[${sourceServer}] Received clearContext for session: ${sessionId}`);

    this.sendClearContextResponse(message.id, sessionId, true, sourceServer)
      .catch(error => console.error(`[${sourceServer}] Failed to send clearContext response:`, error));

    this.emit("clear", {
      sessionId: sessionId,
      id: message.id,
      serverId: sourceServer,
    });

    // Remove session mapping
    this.sessionServerMap.delete(sessionId);
  }

  /**
   * Handle clear message (legacy format)
   */
  private handleClearMessage(message: A2AClearMessage, sourceServer: ServerId): void {
    console.log(`[${sourceServer}] Received clear message for session: ${message.sessionId}`);

    this.sendClearContextResponse(message.id, message.sessionId, true, sourceServer)
      .catch(error => console.error(`[${sourceServer}] Failed to send clear response:`, error));

    this.emit("clear", {
      sessionId: message.sessionId,
      id: message.id,
      serverId: sourceServer,
    });

    this.sessionServerMap.delete(message.sessionId);
  }

  /**
   * Handle tasks/cancel message
   */
  private handleTasksCancelMessage(message: A2ATasksCancelMessage, sourceServer: ServerId): void {
    const sessionId = this.extractSessionId(message);
    if (!sessionId) {
      console.error(`[${sourceServer}] Failed to extract sessionId from tasks/cancel message`);
      return;
    }

    const effectiveTaskId = message.taskId || message.id;

    console.log("\n" + "=".repeat(60));
    console.log(`[${sourceServer}] Received cancel request`);
    console.log(`  Session: ${sessionId}`);
    console.log(`  Task ID: ${effectiveTaskId}`);
    console.log("=".repeat(60) + "\n");

    this.sendTasksCancelResponse(message.id, sessionId, true, sourceServer)
      .catch(error => console.error(`[${sourceServer}] Failed to send cancel response:`, error));

    this.emit("cancel", {
      sessionId: sessionId,
      taskId: effectiveTaskId,
      id: message.id,
      serverId: sourceServer,
    });

    this.activeTasks.delete(effectiveTaskId);
  }

  /**
   * Convert A2AResponseMessage to JSON-RPC 2.0 format
   */
  private convertToJsonRpcFormat(
    response: A2AResponseMessage,
    taskId: string,
    isFinal: boolean = true,
    append: boolean = false
  ): A2AJsonRpcResponse {
    const artifactId = `artifact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    if (response.status === "error" && response.error) {
      return {
        jsonrpc: "2.0",
        id: response.messageId,
        error: {
          code: response.error.code,
          message: response.error.message,
        },
      };
    }

    const parts: Array<{
      kind: "text" | "file" | "data";
      text?: string;
      file?: {
        name: string;
        mimeType: string;
        bytes?: string;
        uri?: string;
      };
      data?: any;
    }> = [];

    if (response.content.type === "text" && response.content.text) {
      parts.push({
        kind: "text",
        text: response.content.text,
      });
    } else if (response.content.type === "file") {
      parts.push({
        kind: "file",
        file: {
          name: response.content.fileName || "file",
          mimeType: response.content.mimeType || "application/octet-stream",
          uri: response.content.mediaUrl,
        },
      });
    }

    const artifactEvent: A2ATaskArtifactUpdateEvent = {
      taskId: taskId,
      kind: "artifact-update",
      append: append,
      lastChunk: isFinal,
      final: isFinal,
      artifact: {
        artifactId: artifactId,
        parts: parts,
      },
    };

    return {
      jsonrpc: "2.0",
      id: response.messageId,
      result: artifactEvent,
    };
  }

  /**
   * Check if at least one server is ready
   */
  isReady(): boolean {
    return (this.state1.ready && this.ws1?.readyState === WebSocket.OPEN) ||
           (this.state2.ready && this.ws2?.readyState === WebSocket.OPEN);
  }

  /**
   * Get combined connection state
   */
  getState(): WebSocketConnectionState {
    const connected = this.state1.connected || this.state2.connected;
    const authenticated = connected; // Auth via headers

    return {
      connected,
      authenticated,
      lastHeartbeat: Math.max(this.state1.lastHeartbeat, this.state2.lastHeartbeat),
      lastAppHeartbeat: 0,
      reconnectAttempts: Math.max(this.state1.reconnectAttempts, this.state2.reconnectAttempts),
      maxReconnectAttempts: 50,
    };
  }

  /**
   * Get individual server states
   */
  getServerStates(): { server1: ServerConnectionState; server2: ServerConnectionState } {
    return {
      server1: { ...this.state1 },
      server2: { ...this.state2 },
    };
  }

  /**
   * Start protocol-level heartbeat for specific server
   */
  private startProtocolHeartbeat(serverId: ServerId): void {
    const interval = setInterval(() => {
      const ws = serverId === 'server1' ? this.ws1 : this.ws2;
      const state = serverId === 'server1' ? this.state1 : this.state2;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();

        const now = Date.now();
        if (state.lastHeartbeat > 0 && now - state.lastHeartbeat > 90000) {
          console.warn(`[${serverId}] Heartbeat timeout, reconnecting...`);
          ws.close();
        }
      }
    }, 30000);

    if (serverId === 'server1') {
      this.heartbeatTimeout1 = interval;
    } else {
      this.heartbeatTimeout2 = interval;
    }
  }

  /**
   * Clear protocol heartbeat for specific server
   */
  private clearProtocolHeartbeat(serverId: ServerId): void {
    const interval = serverId === 'server1' ? this.heartbeatTimeout1 : this.heartbeatTimeout2;

    if (interval) {
      clearInterval(interval);
      if (serverId === 'server1') {
        this.heartbeatTimeout1 = undefined;
      } else {
        this.heartbeatTimeout2 = undefined;
      }
    }
  }

  /**
   * Start application-level heartbeat (shared across both servers)
   */
  private startAppHeartbeat(): void {
    this.appHeartbeatInterval = setInterval(() => {
      const heartbeatMessage: OutboundWebSocketMessage = {
        msgType: "heartbeat",
        agentId: this.config.agentId,
      };

      // Send to all connected servers
      if (this.ws1?.readyState === WebSocket.OPEN) {
        try {
          this.ws1.send(JSON.stringify(heartbeatMessage));
        } catch (error) {
          console.error('[Server1] Failed to send app heartbeat:', error);
        }
      }

      if (this.ws2?.readyState === WebSocket.OPEN) {
        try {
          this.ws2.send(JSON.stringify(heartbeatMessage));
        } catch (error) {
          console.error('[Server2] Failed to send app heartbeat:', error);
        }
      }
    }, 20000);
  }

  /**
   * Schedule reconnection for specific server
   */
  private scheduleReconnect(serverId: ServerId): void {
    const state = serverId === 'server1' ? this.state1 : this.state2;

    if (state.reconnectAttempts >= 50) {
      console.error(`[${serverId}] Max reconnection attempts reached`);
      this.emit("maxReconnectAttemptsReached", serverId);
      return;
    }

    const delay = Math.min(2000 * Math.pow(2, state.reconnectAttempts), 60000);
    state.reconnectAttempts++;

    console.log(`[${serverId}] Scheduling reconnect attempt ${state.reconnectAttempts}/50 in ${delay}ms`);

    const timeout = setTimeout(async () => {
      try {
        if (serverId === 'server1') {
          await this.connectToServer1();
        } else {
          await this.connectToServer2();
        }
        console.log(`[${serverId}] Reconnected successfully`);
      } catch (error) {
        console.error(`[${serverId}] Reconnection failed:`, error);
        this.scheduleReconnect(serverId);
      }
    }, delay);

    if (serverId === 'server1') {
      this.reconnectTimeout1 = timeout;
    } else {
      this.reconnectTimeout2 = timeout;
    }
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.heartbeatTimeout1) {
      clearInterval(this.heartbeatTimeout1);
      this.heartbeatTimeout1 = undefined;
    }

    if (this.heartbeatTimeout2) {
      clearInterval(this.heartbeatTimeout2);
      this.heartbeatTimeout2 = undefined;
    }

    if (this.appHeartbeatInterval) {
      clearInterval(this.appHeartbeatInterval);
      this.appHeartbeatInterval = undefined;
    }

    if (this.reconnectTimeout1) {
      clearTimeout(this.reconnectTimeout1);
      this.reconnectTimeout1 = undefined;
    }

    if (this.reconnectTimeout2) {
      clearTimeout(this.reconnectTimeout2);
      this.reconnectTimeout2 = undefined;
    }

    // Clear stable connection timers
    this.clearStableConnectionCheck('server1');
    this.clearStableConnectionCheck('server2');
  }

  /**
   * Schedule a connection stability check
   * Only reset reconnect counter after connection has been stable for threshold time
   */
  private scheduleStableConnectionCheck(serverId: ServerId): void {
    const timer = setTimeout(() => {
      const state = serverId === 'server1' ? this.state1 : this.state2;
      if (state.connected) {
        console.log(`[${serverId}] Connection stable for ${XiaoYiWebSocketManager.STABLE_CONNECTION_THRESHOLD}ms, resetting reconnect counter`);
        state.reconnectAttempts = 0;
      }
    }, XiaoYiWebSocketManager.STABLE_CONNECTION_THRESHOLD);

    if (serverId === 'server1') {
      this.stableConnectionTimer1 = timer;
    } else {
      this.stableConnectionTimer2 = timer;
    }
  }

  /**
   * Clear the connection stability check timer
   */
  private clearStableConnectionCheck(serverId: ServerId): void {
    const timer = serverId === 'server1' ? this.stableConnectionTimer1 : this.stableConnectionTimer2;

    if (timer) {
      clearTimeout(timer);
      if (serverId === 'server1') {
        this.stableConnectionTimer1 = undefined;
      } else {
        this.stableConnectionTimer2 = undefined;
      }
    }
  }

  /**
   * Type guard for A2A request messages
   * sessionId can be in params OR at top level (fallback)
   */
  private isA2ARequestMessage(data: any): data is A2ARequestMessage {
    return data &&
           typeof data.agentId === "string" &&
           data.jsonrpc === "2.0" &&
           typeof data.id === "string" &&
           data.method === "message/stream" &&
           data.params &&
           typeof data.params.id === "string" &&
           // sessionId can be in params OR at top level
           (typeof data.params.sessionId === "string" || typeof data.sessionId === "string") &&
           data.params.message &&
           typeof data.params.message.role === "string" &&
           Array.isArray(data.params.message.parts);
  }

  /**
   * Get active tasks
   */
  getActiveTasks(): Map<string, any> {
    return new Map(this.activeTasks);
  }

  /**
   * Remove task from active tasks
   */
  removeActiveTask(taskId: string): void {
    this.activeTasks.delete(taskId);
  }

  /**
   * Get server for a specific session
   */
  getServerForSession(sessionId: string): ServerId | undefined {
    return this.sessionServerMap.get(sessionId);
  }

  /**
   * Remove session mapping
   */
  removeSession(sessionId: string): void {
    this.sessionServerMap.delete(sessionId);
  }
}
