// A2A Message Structure Types
// Based on: https://developer.huawei.com/consumer/cn/doc/service/message-stream-0000002505761434

// ============================================================================
// Additional A2A Types from xy_channel (for compatibility)
// ============================================================================

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: A2ARequestParams;
  id: string;
}

export interface A2ARequestParams {
  id: string;
  sessionId: string;
  agentLoginSessionId?: string;
  message: A2AMessage;
}

export interface A2AMessage {
  role: "user" | "assistant" | "system";
  parts: A2AMessagePart[];
}

export type A2AMessagePart = A2ATextPart | A2AFilePart | A2ADataPart;

export interface A2ATextPart {
  kind: "text";
  text: string;
}

export interface A2AFilePart {
  kind: "file";
  file: {
    name: string;
    mimeType: string;
    uri: string;
  };
}

export interface A2ADataPart {
  kind: "data";
  data: {
    event?: A2ADataEvent;
    variables?: {
      systemVariables?: {
        push_id?: string;
      };
    };
    [key: string]: any;
  };
}

export interface A2ADataEvent {
  intentName: string;
  outputs: Record<string, any>;
  status: "success" | "failed";
}

export interface A2AReasoningTextPart {
  kind: "reasoningText";
  reasoningText: string;
}

export interface A2ACommandPart {
  kind: "command";
  command: A2ACommand;
}

export interface A2ACommand {
  header: {
    namespace: string;
    name: string;
  };
  payload: Record<string, any>;
}

export type A2AArtifactPart = A2ATextPart | A2ADataPart | A2ACommandPart | A2AReasoningTextPart;

export interface A2AArtifact {
  artifactId: string;
  parts: A2AArtifactPart[];
}

// ============================================================================
// End of xy_channel types
// ============================================================================

export interface A2ARequestMessage {
  agentId: string; // Required: must match channel config agentId (custom field)
  jsonrpc: "2.0"; // JSON-RPC 2.0 version
  id: string; // Required: message sequence number (消息序列号)
  method: "message/stream"; // A2A method name
  deviceId?: string; // Device ID (optional field)
  conversationId?: string; // Conversation ID (optional top-level field)
  sessionId?: string; // Optional top-level sessionId (some message formats use this)
  params: {
    id: string; // Task ID (任务ID)
    sessionId?: string; // Session ID in params (会话ID) - preferred location
    agentLoginSessionId?: string; // Login session ID (登录凭证ID)
    message: {
      kind?: string; // Message kind (optional, e.g., "message")
      messageId?: string; // Message ID (optional)
      role: "user" | "agent";
      parts: Array<{
        kind: "text" | "file" | "data";
        text?: string;
        file?: {
          name: string;
          mimeType: string;
          bytes?: string;
          uri?: string;
        };
        data?: any;
      }>;
    };
  };
}

export interface A2AResponseMessage {
  sessionId: string;
  messageId: string;
  timestamp: number;
  agentId: string; // Added field for xiaoyi channel
  sender: {
    id: string;
    name?: string;
    type: "agent";
  };
  content: {
    type: "text" | "image" | "audio" | "video" | "file";
    text?: string;
    mediaUrl?: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
  };
  context?: {
    conversationId?: string;
    threadId?: string;
    replyToMessageId?: string;
  };
  status: "success" | "error" | "processing";
  error?: {
    code: string;
    message: string;
  };
}

// A2A JSON-RPC 2.0 Standard Message Format for WebSocket msgDetail
export interface A2AJsonRpcResponse {
  jsonrpc: "2.0";
  id: string; // 与agent-server通信的全局唯一消息序列号
  result?: A2ATaskArtifactUpdateEvent | A2ATaskStatusUpdateEvent | A2AClearContextResult | A2ATasksCancelResult;
  error?: {
    code: number | string;
    message: string;
  };
}

// A2A Task Artifact Update Event (for final responses)
export interface A2ATaskArtifactUpdateEvent {
  taskId: string;
  kind: "artifact-update";
  append?: boolean; // 默认为true
  lastChunk?: boolean; // 默认为true
  final: boolean; // 标识本任务的SSE流是否结束
  artifact: {
    artifactId: string;
    parts: Array<{
      kind: "text" | "file" | "data" | "reasoningText";
      text?: string;
      reasoningText?: string;
      file?: {
        name: string;
        mimeType: string;
        bytes?: string;
        uri?: string;
      };
      data?: any;
    }>;
  };
}

// A2A Task Status Update Event (for intermediate status)
export interface A2ATaskStatusUpdateEvent {
  taskId: string;
  kind: "status-update";
  final: boolean;
  status: {
    message: {
      role: "agent";
      parts: Array<{
        kind: "text";
        text: string;
      }>;
    };
    state: "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "unknown";
  };
}

// A2A Clear Context Result (for clear context responses)
// Reference: https://developer.huawei.com/consumer/cn/doc/service/clear-context-0000002537681163
export interface A2AClearContextResult {
  status: {
    state: "cleared" | "failed" | "unknown";
  };
}

// A2A Tasks Cancel Result (for tasks cancel responses)
// Reference: https://developer.huawei.com/consumer/cn/doc/service/tasks-cancel-0000002537561193
export interface A2ATasksCancelResult {
  id: string;  // 使用请求中的该字段返回
  status: {
    state: "canceled" | "failed" | "unknown";
  };
}

export interface A2AWebSocketMessage {
  type: "message" | "heartbeat" | "auth" | "error";
  data: A2ARequestMessage | A2AResponseMessage | any;
}

// WebSocket outbound message types
export type OutboundMessageType = "clawd_bot_init" | "agent_response" | "heartbeat";

export interface OutboundWebSocketMessage {
  msgType: OutboundMessageType;
  agentId: string; // Required in all message frames
  sessionId?: string; // Required only in agent_response
  taskId?: string; // Required only in agent_response, must match server's id
  msgDetail?: string; // JSON string of A2A response structure, only in agent_response
}

// A2A Clear message structure
// Reference: https://developer.huawei.com/consumer/cn/doc/service/clear-context-0000002537681163
export interface A2AClearMessage {
  agentId: string;
  sessionId: string;
  id: string;
  action: "clear";
  timestamp: number;
}

// A2A Tasks Cancel message structure
// Reference: https://developer.huawei.com/consumer/cn/doc/service/tasks-cancel-0000002537561193
export interface A2ATasksCancelMessage {
  agentId: string;
  sessionId: string;
  id: string;
  action?: "tasks/cancel";  // 可选，兼容旧格式
  method?: "tasks/cancel";  // 可选，新格式使用 method
  taskId?: string;  // 可选，某些情况下可能不包含
  jsonrpc?: "2.0";  // 可选，新格式包含
  conversationId?: string;  // 可选，新格式包含
  timestamp?: number;  // 可选
}

export interface XiaoYiChannelConfig {
  enabled: boolean;
  wsUrl?: string;  // WebSocket server URL (legacy field name)
  wsUrl1?: string; // WebSocket server URL (preferred)
  ak: string;
  sk: string;
  agentId: string;
  enableStreaming?: boolean;  // Enable streaming responses (default: true)

  // Push notification configuration (optional)
  apiId?: string;          // API ID, for push messages (optional)
  pushId?: string;         // Push ID, for push messages (optional)
  taskTimeoutMs?: number;  // Task timeout in milliseconds, default 3600000 (1 hour)

  /**
   * Session cleanup timeout in milliseconds
   * When user clears context, old sessions are cleaned up after this timeout
   * Default: 1 hour (60 * 60 * 1000)
   */
  sessionCleanupTimeoutMs?: number;
}

export interface AuthCredentials {
  ak: string;
  sk: string;
  timestamp: number;
  signature: string;
}

export interface WebSocketConnectionState {
  connected: boolean;
  authenticated: boolean;
  lastHeartbeat: number;
  lastAppHeartbeat: number; // Application layer heartbeat
  reconnectAttempts: number;
  maxReconnectAttempts: number;
}

// Default WebSocket server URL
export const DEFAULT_WS_URL = "wss://hag.cloud.huawei.com/openclaw/v1/ws/link";

// Internal WebSocket configuration (resolved from XiaoYiChannelConfig)
export interface InternalWebSocketConfig {
  wsUrl: string;
  agentId: string;
  ak: string;
  sk: string;
  enableStreaming?: boolean;
  sessionCleanupTimeoutMs?: number;
}

// Connection state
export interface ConnectionState {
  connected: boolean;
  ready: boolean;
  lastHeartbeat: number;
  reconnectAttempts: number;
}

/**
 * Session cleanup state for delayed cleanup
 */
export interface SessionCleanupState {
  sessionId: string;
  markedForCleanupAt: number; // Timestamp when marked for cleanup
  cleanupTimeoutId?: NodeJS.Timeout; // Timeout ID for auto-cleanup
  reason: 'user_cleared' | 'timeout' | 'error';
  accumulatedText?: string; // Track accumulated text for push notification
}

// Session binding types
export interface SessionBinding {
  sessionId: string;
  boundAt: number;
}
