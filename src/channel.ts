import type {
  ChannelPlugin,
  ChannelOutboundContext,
  OutboundDeliveryResult,
  ChannelGatewayContext,
  ChannelMessagingNormalizeTargetContext,
  ChannelStatusGetAccountStatusContext,
  OpenClawConfig,
} from "openclaw";
import { getXiaoYiRuntime } from "./runtime";
import { xiaoyiOnboardingAdapter } from "./onboarding";
import {
  XiaoYiChannelConfig,
  A2ARequestMessage,
  A2AResponseMessage,
} from "./types";
import {
  extractTextFromUrl,
  isImageMimeType,
  isPdfMimeType,
  isTextMimeType,
  downloadAndSaveMediaList,
  buildXiaoYiMediaPayload,
} from "./xiaoyi-media";

/**
 * Track if message handlers have been registered to prevent duplicate registrations
 * when startAccount() is called multiple times due to auto-restart attempts
 */
let handlersRegistered = false;

/**
 * Resolved XiaoYi account configuration (single account mode)
 */
export interface ResolvedXiaoYiAccount {
  accountId: string;
  config: XiaoYiChannelConfig;
}

/**
 * XiaoYi Channel Plugin
 * Implements OpenClaw ChannelPlugin interface for XiaoYi A2A protocol
 * Single account mode only
 */
export const xiaoyiPlugin = {
  id: "xiaoyi",

  meta: {
    id: "xiaoyi",
    label: "XiaoYi",
    selectionLabel: "XiaoYi (小艺)",
    docsPath: "/channels/xiaoyi",
    blurb: "小艺 A2A 协议支持，通过 WebSocket 连接。",
    aliases: ["xiaoyi"],
  },

  capabilities: {
    chatTypes: ["direct"],
    polls: false,
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
  },

  /**
   * Config schema for UI form rendering
   */
  configSchema: {
    schema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          default: false,
          description: "Enable XiaoYi channel",
        },
        wsUrl1: {
          type: "string",
          default: "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
          description: "Primary WebSocket server URL",
        },
        wsUrl2: {
          type: "string",
          default: "wss://116.63.174.231/openclaw/v1/ws/link",
          description: "Secondary WebSocket server URL",
        },
        ak: {
          type: "string",
          description: "Access Key",
        },
        sk: {
          type: "string",
          description: "Secret Key",
        },
        agentId: {
          type: "string",
          description: "Agent ID",
        },
        debug: {
          type: "boolean",
          default: false,
          description: "Enable debug logging",
        },
        apiId: {
          type: "string",
          default: "",
          description: "API ID for push notifications",
        },
        pushId: {
          type: "string",
          default: "",
          description: "Push ID for push notifications",
        },
        taskTimeoutMs: {
          type: "number",
          default: 3600000,
          description: "Task timeout in milliseconds (default: 1 hour)",
        },
      },
    },
  },

  onboarding: xiaoyiOnboardingAdapter,

  /**
   * Config adapter - single account mode
   */
  config: {
    listAccountIds: (cfg: OpenClawConfig) => {
      const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;
      if (!channelConfig || !channelConfig.enabled) {
        return [];
      }
      // Single account mode: always return "default"
      return ["default"];
    },

    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      // Single account mode: always use "default"
      const resolvedAccountId = "default";

      // Access channel config from cfg.channels.xiaoyi
      const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig | undefined;

      // If channel is not configured yet, return empty config
      if (!channelConfig) {
        return {
          accountId: resolvedAccountId,
          config: {
            enabled: false,
            wsUrl: "",
            wsUrl1: "",
            wsUrl2: "",
            ak: "",
            sk: "",
            agentId: "",
          },
          enabled: false,
        };
      }

      return {
        accountId: resolvedAccountId,
        config: channelConfig,
        enabled: channelConfig.enabled !== false,
      };
    },

    defaultAccountId: (cfg: OpenClawConfig) => {
      const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;
      if (!channelConfig || !channelConfig.enabled) {
        return undefined;
      }
      // Single account mode: always return "default"
      return "default";
    },

    isConfigured: (account: any, cfg: OpenClawConfig) => {
      // Safely check if all required fields are present and non-empty
      if (!account || !account.config) {
        return false;
      }

      const config = account.config;

      // Check each field is a string and has content after trimming
      // Note: wsUrl1/wsUrl2 are optional (defaults will be used if not provided)
      const hasAk = typeof config.ak === 'string' && config.ak.trim().length > 0;
      const hasSk = typeof config.sk === 'string' && config.sk.trim().length > 0;
      const hasAgentId = typeof config.agentId === 'string' && config.agentId.trim().length > 0;

      return hasAk && hasSk && hasAgentId;
    },

    isEnabled: (account: any, cfg: OpenClawConfig) => {
      return account?.enabled !== false;
    },

    disabledReason: (account: any, cfg: OpenClawConfig) => {
      return "Channel is disabled in configuration";
    },

    unconfiguredReason: (account: any, cfg: OpenClawConfig) => {
      return "Missing required configuration: ak, sk, or agentId (wsUrl1/wsUrl2 are optional, defaults will be used)";
    },

    describeAccount: (account: any, cfg: OpenClawConfig) => ({
      accountId: account.accountId,
      name: 'XiaoYi',
      enabled: account.enabled,
      configured: Boolean(
        account.config?.ak && account.config?.sk && account.config?.agentId
      ),
    }),
  },

  /**
   * Outbound adapter - send messages
   */
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,

    sendText: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
      const runtime = getXiaoYiRuntime();
      const connection = runtime.getConnection();

      if (!connection || !connection.isReady()) {
        throw new Error("XiaoYi channel not connected");
      }

      // Get account config to retrieve agentId
      const resolvedAccount = ctx.account as ResolvedXiaoYiAccount;
      const agentId = resolvedAccount.config.agentId;

      // Use 'to' as sessionId (it's set from incoming message's sessionId)
      const sessionId = ctx.to;

      // Get taskId from runtime's session mapping (must exist - from original A2A request)
      const taskId = runtime.getTaskIdForSession(sessionId);
      if (!taskId) {
        throw new Error(`Cannot send outbound message: No taskId found for session ${sessionId}. Outbound messages must be in response to an incoming A2A request.`);
      }

      // Build A2A response message
      const response: A2AResponseMessage = {
        sessionId: sessionId,
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        agentId: agentId,
        sender: {
          id: agentId,
          name: "OpenClaw Agent",
          type: "agent",
        },
        content: {
          type: "text",
          text: ctx.text,
        },
        context: ctx.replyToId ? {
          replyToMessageId: ctx.replyToId,
        } : undefined,
        status: "success",
      };

      // Send via WebSocket with taskId and sessionId
      await connection.sendResponse(response, taskId, sessionId);

      return {
        channel: "xiaoyi",
        messageId: response.messageId,
        conversationId: sessionId,
        timestamp: response.timestamp,
      };
    },

    sendMedia: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
      const runtime = getXiaoYiRuntime();
      const connection = runtime.getConnection();

      if (!connection || !connection.isReady()) {
        throw new Error("XiaoYi channel not connected");
      }

      const resolvedAccount = ctx.account as ResolvedXiaoYiAccount;
      const agentId = resolvedAccount.config.agentId;

      // Use 'to' as sessionId
      const sessionId = ctx.to;

      // Get taskId from runtime's session mapping (must exist - from original A2A request)
      const taskId = runtime.getTaskIdForSession(sessionId);
      if (!taskId) {
        throw new Error(`Cannot send outbound media: No taskId found for session ${sessionId}. Outbound messages must be in response to an incoming A2A request.`);
      }

      // Build A2A response message with media
      const response: A2AResponseMessage = {
        sessionId: sessionId,
        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        agentId: agentId,
        sender: {
          id: agentId,
          name: "OpenClaw Agent",
          type: "agent",
        },
        content: {
          type: "image", // Assume image for now, could be extended
          text: ctx.text,
          mediaUrl: ctx.mediaUrl,
        },
        context: ctx.replyToId ? {
          replyToMessageId: ctx.replyToId,
        } : undefined,
        status: "success",
      };

      await connection.sendResponse(response, taskId, sessionId);

      return {
        channel: "xiaoyi",
        messageId: response.messageId,
        conversationId: sessionId,
        timestamp: response.timestamp,
      };
    },
  },

  /**
   * Gateway adapter - manage connections
   */
  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedXiaoYiAccount>) => {
      console.log("XiaoYi: startAccount() called - START");
      const runtime = getXiaoYiRuntime();
      const resolvedAccount = ctx.account;
      const config = ctx.cfg;

      // Start WebSocket connection (single account mode)
      // Wrap in try-catch to prevent startup errors from causing auto-restart
      let connection = null;
      try {
        await runtime.start(resolvedAccount.config);
        connection = runtime.getConnection();
      } catch (error) {
        console.error("XiaoYi: [STARTUP] Failed to start WebSocket connection:", error);
        // Don't throw - let the connection retry logic handle reconnection
        // The runtime.start() will handle reconnection internally
      }

      // Setup message handler IMMEDIATELY after connection is established
      if (!connection) {
        connection = runtime.getConnection();
      }

      if (!connection) {
        console.warn("XiaoYi: [STARTUP] No WebSocket connection available yet, will retry...");
        // Throw error to prevent auto-restart - let runtime handle reconnection
        // The runtime.start() will keep trying to reconnect internally
        throw new Error("XiaoYi: WebSocket connection not available, runtime will retry");
      }

      // Only register handlers once to prevent duplicate message processing
      // when startAccount() is called multiple times due to auto-restart attempts
      if (!handlersRegistered) {
        console.log("XiaoYi: [STARTUP] Registering message and cancel handlers");

        // Setup message handler with try-catch to prevent individual message errors from crashing the channel
        connection.on("message", async (message: A2ARequestMessage) => {
        // CRITICAL: Use dynamic require to get the latest runtime module after hot-reload
        const { getXiaoYiRuntime } = require("./runtime");
        const runtime = getXiaoYiRuntime();

        console.log(`XiaoYi: [Message Handler] Using runtime instance: ${runtime.getInstanceId()}`);

        // CRITICAL FIX: Extract and store config values at message handler level
        // This prevents "Cannot read properties of undefined" errors in concurrent scenarios
        // where the outer scope's resolvedAccount might become unavailable
        const messageHandlerAgentId = resolvedAccount.config?.agentId;
        const messageHandlerAccountId = resolvedAccount.accountId;
        const messageHandlerConfig = resolvedAccount.config;

        if (!messageHandlerAgentId) {
          console.error("XiaoYi: [FATAL] agentId not available in resolvedAccount.config");
          return;
        }

        // Set task timeout time from configuration
        runtime.setTaskTimeout(messageHandlerConfig.taskTimeoutMs || 3600000);

        console.log(`XiaoYi: [Message Handler] Stored config values - agentId: ${messageHandlerAgentId}, accountId: ${messageHandlerAccountId}`);

        // For message/stream, prioritize params.sessionId, fallback to top-level sessionId
        const sessionId = message.params?.sessionId || message.sessionId;

        // Validate sessionId exists
        if (!sessionId) {
          console.error("XiaoYi: Missing sessionId in message, cannot process");
          return;
        }

        // Get PluginRuntime from our runtime wrapper
        const pluginRuntime = runtime.getPluginRuntime();
        if (!pluginRuntime) {
          console.error("PluginRuntime not available");
          return;
        }

        // Extract text, file, and image content from parts array
        let bodyText = "";
        let fileAttachments: string[] = [];
        const mediaFiles: Array<{ uri: string; mimeType: string; name: string }> = [];

        for (const part of message.params.message.parts) {
          if (part.kind === "text" && part.text) {
            // Handle text content
            bodyText += part.text;
          } else if (part.kind === "file" && part.file) {
            // Handle file content
            const { uri, mimeType, name } = part.file;

            if (!uri) {
              console.warn(`XiaoYi: File part without URI, skipping: ${name}`);
              continue;
            }

            try {
              // All files are downloaded to local disk and passed to OpenClaw
              // No type validation - let Agent decide how to handle them
              console.log(`XiaoYi: Processing file: ${name} (${mimeType})`);
              mediaFiles.push({ uri, mimeType, name });

              // For text-based files, also extract content inline
              if (isTextMimeType(mimeType)) {
                try {
                  const textContent = await extractTextFromUrl(uri, 5_000_000, 30_000);
                  bodyText += `\n\n[文件内容: ${name}]\n${textContent}`;
                  fileAttachments.push(`[文件: ${name}]`);
                  console.log(`XiaoYi: Successfully extracted text from: ${name}`);
                } catch (textError) {
                  // Text extraction failed, but file is still in mediaFiles
                  console.warn(`XiaoYi: Text extraction failed for ${name}, will download as binary`);
                  fileAttachments.push(`[文件: ${name}]`);
                }
              } else {
                // Binary files (images, pdf, office docs, etc.)
                fileAttachments.push(`[文件: ${name}]`);
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              console.error(`XiaoYi: Failed to process file ${name}: ${errorMsg}`);
              fileAttachments.push(`[文件处理失败: ${name} - ${errorMsg}]`);
            }
          }
          // Ignore kind: "data" as per user request
        }

        // Log summary of processed attachments
        if (fileAttachments.length > 0) {
          console.log(`XiaoYi: Processed ${fileAttachments.length} file(s): ${fileAttachments.join(", ")}`);
        }

        // Download media files to local disk (like feishu does)
        let mediaPayload: ReturnType<typeof buildXiaoYiMediaPayload> = {};
        if (mediaFiles.length > 0) {
          console.log(`XiaoYi: Downloading ${mediaFiles.length} media file(s) to local disk...`);
          const downloadedMedia = await downloadAndSaveMediaList(
            pluginRuntime,
            mediaFiles,
            { maxBytes: 30_000_000, timeoutMs: 60_000 }
          );
          console.log(`XiaoYi: Successfully downloaded ${downloadedMedia.length}/${mediaFiles.length} file(s)`);
          mediaPayload = buildXiaoYiMediaPayload(downloadedMedia);
        }

        // Determine sender ID from role
        const senderId = message.params.message.role === "user" ? "user" : message.agentId;

        // Build MsgContext for OpenClaw's message pipeline
        // Include media payload so OpenClaw can access local file paths
        const msgContext = {
          Body: bodyText,
          From: senderId,
          To: sessionId,
          SessionKey: `xiaoyi:${resolvedAccount.accountId}:${sessionId}`,
          AccountId: resolvedAccount.accountId,
          MessageSid: message.id, // Use top-level id as message sequence number
          Timestamp: Date.now(), // Generate timestamp since new format doesn't include it
          Provider: "xiaoyi",
          Surface: "xiaoyi",
          ChatType: "direct",
          SenderName: message.params.message.role, // Use role as sender name
          SenderId: senderId,
          OriginatingChannel: "xiaoyi" as any,
          ...mediaPayload, // Spread MediaPath, MediaPaths, MediaType, MediaTypes
        };

        // Log the message context for debugging
        console.log("\n" + "=".repeat(60));
        console.log("XiaoYi: [DEBUG] Message Context");
        console.log("  " + JSON.stringify({
          Body: msgContext.Body.substring(0, 50) + "...",
          From: msgContext.From,
          To: msgContext.To,
          SessionKey: msgContext.SessionKey,
          AccountId: msgContext.AccountId,
          Provider: msgContext.Provider,
          Surface: msgContext.Surface,
          MediaPath: (msgContext as any).MediaPath,
          MediaPaths: (msgContext as any).MediaPaths,
          MediaType: (msgContext as any).MediaType,
        }, null, 2));
        console.log("=".repeat(60) + "\n");

        // Dispatch message using OpenClaw's reply dispatcher
        try {
          console.log("\n" + "=".repeat(60));
          console.log(`XiaoYi: [MESSAGE] Processing user message`);
          console.log(`  Session: ${sessionId}`);
          console.log(`  Task ID: ${message.params.id}`);
          console.log(`  User input: ${bodyText.substring(0, 50)}${bodyText.length > 50 ? "..." : ""}`);
          console.log(`  Images: ${mediaFiles.length}`);
          console.log("=".repeat(60) + "\n");

          // Get taskId from this message's params.id
          // NOTE: We store this AFTER concurrent check to avoid overwriting active task's taskId
          const currentTaskId = message.params.id;

          // ==================== CONCURRENT REQUEST DETECTION ====================
          // Check if this session already has an active agent run
          // If so, send an immediate "busy" response and skip processing
          if (runtime.isSessionActive(sessionId)) {
            console.log("\n" + "=".repeat(60));
            console.log(`[CONCURRENT] Session ${sessionId} has an active agent run`);
            console.log(`  Action: Sending busy response and skipping message`);
            console.log("=".repeat(60) + "\n");

            const conn = runtime.getConnection();
            if (conn) {
              try {
                await conn.sendResponse({
                  sessionId: sessionId,
                  messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  timestamp: Date.now(),
                  agentId: messageHandlerAgentId,
                  sender: {
                    id: messageHandlerAgentId,
                    name: "OpenClaw Agent",
                    type: "agent",
                  },
                  content: {
                    type: "text",
                    text: "上一个任务仍在处理中，请稍后再试",
                  },
                  status: "success",
                }, currentTaskId, sessionId, true, false);
                console.log(`[CONCURRENT] Busy response sent to session ${sessionId}\n`);
              } catch (error) {
                console.error(`[CONCURRENT] Failed to send busy response:`, error);
              }
            }
            return; // Skip processing this concurrent request
          }
          // =================================================================

          // Store sessionId -> taskId mapping (only after passing concurrent check)
          runtime.setTaskIdForSession(sessionId, currentTaskId);

          const startTime = Date.now();
          let accumulatedText = "";
          let sentTextLength = 0; // Track sent text length for streaming

          // ==================== CREATE ABORT CONTROLLER ====================
          // Create AbortController for this session to allow cancelation
          const abortControllerResult = runtime.createAbortControllerForSession(sessionId);
          if (!abortControllerResult) {
            console.error(`[ERROR] Failed to create AbortController for session ${sessionId}`);
            return;
          }
          const { controller: abortController, signal: abortSignal } = abortControllerResult;
          // ================================================================

          // ==================== 1-HOUR TASK TIMEOUT PROTECTION ====================
          // Start 1-hour task timeout timer
          // Will trigger once after 1 hour if no response received
          console.log(`[TASK TIMEOUT] Starting ${messageHandlerConfig.taskTimeoutMs || 3600000}ms task timeout protection for session ${sessionId}`);

          // Define task timeout handler (will be called once after 1 hour)
          const createTaskTimeoutHandler = (): ((sessionId: string, taskId: string) => Promise<void>) => {
            return async (timeoutSessionId: string, timeoutTaskId: string) => {
              const elapsed = Date.now() - startTime;
              console.log("\n" + "=".repeat(60));
              console.log(`[TASK TIMEOUT] 1-hour timeout triggered for session ${sessionId}`);
              console.log(`  Elapsed: ${elapsed}ms`);
              console.log(`  Task ID: ${currentTaskId}`);
              console.log("=".repeat(60) + "\n");

              const conn = runtime.getConnection();
              if (conn) {
                try {
                  // Send default message with isFinal=true
                  await conn.sendResponse({
                    sessionId: timeoutSessionId,
                    messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: Date.now(),
                    agentId: messageHandlerAgentId,
                    sender: { id: messageHandlerAgentId, name: "OpenClaw Agent", type: "agent" },
                    content: { type: "text", text: "任务还在处理中，完成后将提醒您~" },
                    status: "success",
                  }, timeoutTaskId, timeoutSessionId, true, false);  // isFinal=true

                  console.log(`[TASK TIMEOUT] Default message sent (isFinal=true) to session ${timeoutSessionId}\n`);
                } catch (error) {
                  console.error(`[TASK TIMEOUT] Failed to send default message:`, error);
                }
              }

              // Cancel 60-second periodic timeout
              runtime.clearSessionTimeout(timeoutSessionId);

              // Mark as waiting for push state
              runtime.markSessionWaitingForPush(timeoutSessionId, timeoutTaskId);
            };
          };

          // Start 1-hour task timeout timer
          runtime.setTaskTimeoutForSession(sessionId, currentTaskId, createTaskTimeoutHandler());

          // Also start 60-second periodic timeout for status updates (for messages before 1-hour timeout)
          const timeoutConfig = runtime.getTimeoutConfig();
          const createPeriodicTimeoutHandler = (): (() => Promise<void>) => {
            return async () => {
              // Skip if already waiting for push (1-hour timeout already triggered)
              if (runtime.isSessionWaitingForPush(sessionId, currentTaskId)) {
                return;
              }

              const elapsed = Date.now() - startTime;
              console.log("\n" + "=".repeat(60));
              console.log(`[TIMEOUT] Periodic timeout triggered for session ${sessionId}`);
              console.log(`  Elapsed: ${elapsed}ms`);
              console.log("=".repeat(60) + "\n");

              const conn = runtime.getConnection();
              if (conn) {
                try {
                  await conn.sendStatusUpdate(currentTaskId, sessionId, timeoutConfig.message);
                  console.log(`[TIMEOUT] Status update sent successfully to session ${sessionId}\n`);
                } catch (error) {
                  console.error(`[TIMEOUT] Failed to send status update:`, error);
                }
              }
            };
          };
          runtime.setTimeoutForSession(sessionId, createPeriodicTimeoutHandler());
          // ==================== END TASK TIMEOUT PROTECTION ====================

          // ==================== CREATE STREAMING DISPATCHER ====================
          // ==================== DISPATCHER OPTIONS ====================
          // Define dispatcher options for dispatchInboundMessageWithBufferedDispatcher
          // This uses the standard OpenClaw pattern which properly handles dispatcher lifecycle
          const dispatcherOptions = {
            humanDelay: 0,
            onReplyStart: async () => {
              const elapsed = Date.now() - startTime;
              console.log("\n" + "=".repeat(60));
              console.log("XiaoYi: [START] Reply started after " + elapsed + "ms");
              console.log("  Session: " + sessionId);
              console.log("  Task ID: " + currentTaskId);
              console.log("=".repeat(60) + "\n");

              // Send immediate status update to let user know Agent is working
              const conn = runtime.getConnection();
              if (conn) {
                try {
                  await conn.sendStatusUpdate(currentTaskId, sessionId, "任务正在处理中，请稍后");
                  console.log("✓ [START] Initial status update sent\n");
                } catch (error) {
                  console.error("✗ [START] Failed to send initial status update:", error);
                }
              }
            },
            deliver: async (payload: any, info: { kind: "tool" | "block" | "final" }) => {
              const elapsed = Date.now() - startTime;
              const text = payload.text || "";
              const kind = info.kind;
              const payloadStatus = payload.status;

              // IMPORTANT: Check if this is actually the final message
              // Check multiple sources: payload.status, payload.queuedFinal, AND info.kind
              // info.kind is the most reliable indicator for final messages
              const isFinal = payloadStatus === "final" || payload.queuedFinal === true || kind === "final";

              // If session is waiting for push (1-hour timeout occurred), ignore non-final responses
              if (runtime.isSessionWaitingForPush(sessionId, currentTaskId) && !payload.queuedFinal && info.kind !== "final") {
                console.log(`[TASK TIMEOUT] Ignoring non-final response for session ${sessionId} (already timed out)`);
                return;
              }

              accumulatedText = text;

              console.log("\n" + "█".repeat(70));
              console.log("📨 [DELIVER] Payload received");
              console.log("  Session: " + sessionId);
              console.log("  Elapsed: " + elapsed + "ms");
              console.log("  Info Kind: \"" + kind + "\"");
              console.log("  Payload Status: \"" + (payloadStatus || "unknown") + "\"");
              console.log("  Is Final: " + isFinal);
              console.log("  Text length: " + text.length + " chars");
              console.log("  Sent so far: " + sentTextLength + " chars");
              if (text.length > 0) {
                console.log("  Text preview: \"" + text.substring(0, 80) + (text.length > 80 ? "..." : "") + "\"");
              }
              console.log("█".repeat(70) + "\n");

              // Only check for abort, NOT timeout
              // Timeout is just for user notification, final responses should still be delivered
              if (runtime.isSessionAborted(sessionId)) {
                console.log("\n" + "=".repeat(60));
                console.log("[ABORT] Response received AFTER abort");
                console.log("  Session: " + sessionId);
                console.log("  Action: DISCARDING");
                console.log("=".repeat(60) + "\n");
                return;
              }

              // NOTE: We DON'T check timeout here anymore
              // Even if timeout occurred, we should still deliver the final response
              // Timeout was just to keep user informed, not to discard results

              const conn = runtime.getConnection();
              if (!conn) {
                console.error("✗ XiaoYi: Connection not available\n");
                return;
              }

              // ==================== FIX: Empty text handling ====================
              // If text is empty but this is not final, ALWAYS send a status update
              // This ensures user gets feedback for EVERY Agent activity (tool calls, subagent calls, etc.)
              if ((!text || text.length === 0) && !isFinal) {
                console.log("\n" + "=".repeat(60));
                console.log("[STREAM] Empty " + kind + " response detected");
                console.log("  Session: " + sessionId);
                console.log("  Action: Sending status update (no throttling)");
                console.log("=".repeat(60) + "\n");

                try {
                  await conn.sendStatusUpdate(currentTaskId, sessionId, "任务正在处理中，请稍后");
                  console.log("✓ Status update sent\n");
                } catch (error) {
                  console.error("✗ Failed to send status update:", error);
                }
                return;
              }
              // ==================== END FIX ====================

              const responseStatus = isFinal ? "success" : "processing";
              const incrementalText = text.slice(sentTextLength);

              // ==================== FIX: Always send isFinal=false in deliver ====================
              // All responses from deliver callback are sent with isFinal=false
              // The final isFinal=true will be sent in onIdle callback when ALL processing is complete
              const shouldSendFinal = false;

              // Compute isAppend based on shouldSendFinal (not isFinal payload property)
              // This ensures consistency between what we log and what we actually send
              const isAppend = !shouldSendFinal && incrementalText.length > 0;

              if (incrementalText.length > 0 || isFinal) {
                console.log("\n" + "-".repeat(60));
                console.log("XiaoYi: [STREAM] Sending response");
                console.log("  Response Status: " + responseStatus);
                console.log("  Is Final: " + isFinal);
                console.log("  Is Append: " + isAppend);
                console.log("-".repeat(60) + "\n");

                const response: A2AResponseMessage = {
                  sessionId: sessionId,
                  messageId: "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
                  timestamp: Date.now(),
                  agentId: messageHandlerAgentId,  // Use stored value instead of resolvedAccount.config.agentId
                  sender: {
                    id: messageHandlerAgentId,  // Use stored value instead of resolvedAccount.config.agentId
                    name: "OpenClaw Agent",
                    type: "agent",
                  },
                  content: {
                    type: "text",
                    text: isFinal ? text : incrementalText,
                  },
                  status: responseStatus,
                };

                try {
                  await conn.sendResponse(response, currentTaskId, sessionId, shouldSendFinal, isAppend);
                  console.log("✓ Sent (status=" + responseStatus + ", isFinal=false, append=" + isAppend + ")\n");
                } catch (error) {
                  console.error("✗ Failed to send:", error);
                }

                sentTextLength = text.length;
              }

              // ==================== FIX: SubAgent-friendly cleanup logic ====================
              // Only mark session as completed if we're truly done (no more subagent responses expected)
              // The key insight: we should NOT cleanup on every "final" payload, because subagents
              // can generate additional responses after the main agent returns "final".
              //
              // Instead, we let onIdle handle the cleanup, which is called after ALL processing is done.
              if (isFinal) {
                // Clear timeout but DON'T mark session as completed yet
                // SubAgent might still send more responses
                runtime.clearSessionTimeout(sessionId);
                console.log("[CLEANUP] Final payload received, but NOT marking session completed yet (waiting for onIdle)\n");
              }
              // ==================== END FIX ====================
            },
            onError: (err: Error, info: any) => {
              console.error("\n" + "=".repeat(60));
              console.error("XiaoYi: [ERROR] " + info.kind + " failed: " + String(err));
              console.log("=".repeat(60) + "\n");

              runtime.clearSessionTimeout(sessionId);
              runtime.clearTaskTimeoutForSession(sessionId);
              runtime.clearSessionWaitingForPush(sessionId, currentTaskId);
              runtime.clearAbortControllerForSession(sessionId);

              // Check if session was cleared
              const conn = runtime.getConnection();
              if (conn && conn.isSessionPendingCleanup(sessionId)) {
                conn.forceCleanupSession(sessionId);
              }

              runtime.markSessionCompleted(sessionId);
            },
            onIdle: async () => {
              const elapsed = Date.now() - startTime;
              console.log("\n" + "=".repeat(60));
              console.log("XiaoYi: [IDLE] Processing complete");
              console.log("  Total time: " + elapsed + "ms");
              console.log("=".repeat(60) + "\n");

              // Clear 1-hour task timeout timer
              runtime.clearTaskTimeoutForSession(sessionId);

              // ==================== CHECK IF SESSION WAS CLEARED ====================
              const conn = runtime.getConnection();
              const isPendingCleanup = conn && conn.isSessionPendingCleanup(sessionId);
              const isWaitingForPush = runtime.isSessionWaitingForPush(sessionId, currentTaskId);

              // ==================== PUSH NOTIFICATION LOGIC ====================
              // Send push if task timeout was triggered (regardless of session cleanup status)
              // This ensures users get notified when long-running tasks complete
              if (isWaitingForPush && accumulatedText.length > 0) {
                const pushReason = isPendingCleanup
                  ? `Session ${sessionId} was cleared`
                  : `Session ${sessionId} task timeout triggered`;
                console.log(`[CLEANUP] ${pushReason}, sending push notification`);

                try {
                  const { XiaoYiPushService } = require("./push");
                  const pushService = new XiaoYiPushService(messageHandlerConfig);

                  if (pushService.isConfigured()) {
                    // Generate summary
                    const summary = accumulatedText.length > 30
                      ? accumulatedText.substring(0, 30) + "..."
                      : accumulatedText;

                    await pushService.sendPush(summary, "后台任务已完成：" + summary);
                    console.log("✓ [CLEANUP] Push notification sent\n");

                    // Clear push waiting state for this specific task
                    runtime.clearSessionWaitingForPush(sessionId, currentTaskId);
                  } else {
                    console.log("[CLEANUP] Push not configured, skipping notification");
                    runtime.clearSessionWaitingForPush(sessionId, currentTaskId);
                  }
                } catch (error) {
                  console.error("[CLEANUP] Error sending push:", error);
                  runtime.clearSessionWaitingForPush(sessionId, currentTaskId);
                }

                // If session was cleared, update cleanup state
                if (isPendingCleanup) {
                  conn?.updateAccumulatedTextForCleanup(sessionId, accumulatedText);
                  conn?.forceCleanupSession(sessionId);
                }
              }
              // ==================== NORMAL WEBSOCKET FLOW (no timeout triggered) ====================
              else if (!isPendingCleanup) {
                // Normal flow: send WebSocket response (no timeout, session still active)
                const conn = runtime.getConnection();
                if (conn) {
                  try {
                    await conn.sendResponse({
                      sessionId: sessionId,
                      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      timestamp: Date.now(),
                      agentId: messageHandlerAgentId,
                      sender: {
                        id: messageHandlerAgentId,
                        name: "OpenClaw Agent",
                        type: "agent",
                      },
                      content: {
                        type: "text",
                        text: accumulatedText,
                      },
                      status: "success",
                    }, currentTaskId, sessionId, true, false);  // isFinal=true, append=false
                    console.log("✓ [IDLE] Final response sent (isFinal=true)\n");
                  } catch (error) {
                    console.error("✗ [IDLE] Failed to send final response:", error);
                  }
                }
              }
              // ==================== SESSION CLEARED BUT NO TIMEOUT ====================
              else {
                // Session was cleared but no timeout triggered - edge case, just cleanup
                console.log(`[CLEANUP] Session ${sessionId} was cleared but no push needed`);
                conn?.forceCleanupSession(sessionId);
              }

              // This is called AFTER all processing is done (including subagents)
              // NOW we can safely mark the session as completed
              runtime.clearAbortControllerForSession(sessionId);
              runtime.markSessionCompleted(sessionId);
              console.log("[CLEANUP] Session marked as completed in onIdle\n");
            },
          };

          try {
            // Use standard OpenClaw pattern with dispatchReplyWithBufferedBlockDispatcher
            // This properly handles dispatcher lifecycle:
            // 1. Calls dispatcher.markComplete() after run() completes
            // 2. Waits for waitForIdle() to ensure all deliveries are done
            // 3. Then calls markDispatchIdle() in the finally block
            const result = await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgContext,
              cfg: config,
              dispatcherOptions: dispatcherOptions,
              replyOptions: {
                abortSignal: abortSignal,
              },
            });

            const { queuedFinal, counts } = result;

            console.log("\n" + "=".repeat(60));
            console.log("XiaoYi: [DISPATCH] Summary");
            console.log("  Queued Final: " + queuedFinal);
            if (counts && Object.keys(counts).length > 0) {
              console.log("  Counts:", JSON.stringify(counts, null, 2));
            }
            console.log("=".repeat(60) + "\n");

            // ==================== ANALYZE EXECUTION RESULT ====================
            // Check if Agent produced any output
            const hasAnyCounts = counts && (
              (counts.tool && counts.tool > 0) ||
              (counts.block && counts.block > 0) ||
              (counts.final && counts.final > 0)
            );

            if (!hasAnyCounts) {
              // Scenario 1: No Agent output detected
              // This could mean:
              // a) SubAgent running in background (main Agent returned)
              // b) Concurrent request (another Agent already running on this session)
              console.log("\n" + "=".repeat(60));
              console.log("[NO OUTPUT] Agent produced no output");
              console.log("  Session: " + sessionId);
              console.log("  Checking if there's another active Agent...");
              console.log("=".repeat(60) + "\n");

              // Check if there's an active Agent on this session
              // We use the existence of deliver callback triggers as an indicator
              // If the dispatcher's onIdle will be called later, an Agent is still running
              const conn = runtime.getConnection();

              if (conn) {
                // IMPORTANT: Send a response to user for THIS request
                // User needs to know what's happening
                try {
                  const response: A2AResponseMessage = {
                    sessionId: sessionId,
                    messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: Date.now(),
                    agentId: messageHandlerAgentId,  // Use stored value instead of resolvedAccount.config.agentId
                    sender: {
                      id: messageHandlerAgentId,  // Use stored value instead of resolvedAccount.config.agentId
                      name: "OpenClaw Agent",
                      type: "agent",
                    },
                    content: {
                      type: "text",
                      text: "任务正在处理中，请稍候...",
                    },
                    status: "success",
                  };

                  // Send response with isFinal=true to close THIS request
                  await conn.sendResponse(response, currentTaskId, sessionId, true, false);
                  console.log("✓ [NO OUTPUT] Response sent to user\n");
                } catch (error) {
                  console.error("✗ [NO OUTPUT] Failed to send response:", error);
                }
              }

              // CRITICAL: Don't cleanup resources yet!
              // The original Agent might still be running and needs these resources
              // onIdle will be called when the original Agent completes
              console.log("[NO OUTPUT] Keeping resources alive for potential background Agent\n");
              // Note: No need to call markDispatchIdle() manually
              // dispatchInboundMessageWithBufferedDispatcher handles this in its finally block
            } else {
              // Scenario 2: Normal execution with output
              // - Agent produced output synchronously
              // - All cleanup is already handled in deliver/onIdle callbacks
              console.log("[NORMAL] Agent produced output, cleanup handled in callbacks");
              // Note: No need to call markDispatchIdle() manually
              // dispatchInboundMessageWithBufferedDispatcher handles this in its finally block
            }
            // ==================== END ANALYSIS ====================

          } catch (error) {
            console.error("XiaoYi: [ERROR] Error dispatching message:", error);
            // Clear timeout on error
            runtime.clearSessionTimeout(sessionId);
            runtime.clearTaskTimeoutForSession(sessionId);
            runtime.clearSessionWaitingForPush(sessionId, currentTaskId);
            // Clear abort controller on error
            runtime.clearAbortControllerForSession(sessionId);
            // Mark session as completed on error
            runtime.markSessionCompleted(sessionId);
            // Note: No need to call markDispatchIdle() manually
            // dispatchInboundMessageWithBufferedDispatcher handles this in its finally block
          }
        } catch (error) {
          console.error("XiaoYi: [ERROR] Unexpected error in message handler:", error);
        }
      });

      // Setup cancel handler
      // When tasks/cancel is received, abort the current session's agent run
      connection.on("cancel", async (data: any) => {
        const { sessionId } = data;

        console.log("\n" + "=".repeat(60));
        console.log(`XiaoYi: [CANCEL] Cancel event received`);
        console.log(`  Session: ${sessionId}`);
        console.log(`  Task ID: ${data.taskId || "N/A"}`);
        console.log("=".repeat(60) + "\n");

        // Abort the session's agent run
        const aborted = runtime.abortSession(sessionId);

        if (aborted) {
          console.log(`[CANCEL] Successfully triggered abort for session ${sessionId}`);
        } else {
          console.log(`[CANCEL] No active agent run found for session ${sessionId}`);
        }

        // Clear timeout and push state as the session is being canceled
        runtime.clearTaskTimeoutForSession(sessionId);
        runtime.clearSessionWaitingForPush(sessionId, data.taskId);
        runtime.markSessionCompleted(sessionId);
      });

      // Handle clear context events
      connection.on("clear", async (data: any) => {
        const { sessionId, serverId } = data;

        console.log("\n" + "=".repeat(60));
        console.log("[CLEAR] Context cleared by user");
        console.log(`  Session: ${sessionId}`);
        console.log("=".repeat(60) + "\n");

        // Check if there's an active task for this session
        const hasActiveTask = runtime.isSessionActive(sessionId);

        if (hasActiveTask) {
          console.log(`[CLEAR] Active task exists for session ${sessionId}, will continue in background`);
          // Session is already marked for cleanup in websocket.ts
          // Just track that we're waiting for completion
        } else {
          console.log(`[CLEAR] No active task for session ${sessionId}, clean up immediately`);
          const conn = runtime.getConnection();
          if (conn) {
            conn.forceCleanupSession(sessionId);
          }
        }
      });

        // Mark handlers as registered to prevent duplicate registration
        handlersRegistered = true;
      } else {
        console.log("XiaoYi: [STARTUP] Handlers already registered, skipping duplicate registration");
      }

      console.log("XiaoYi: Event handlers registered");

      // Keep the channel running by waiting for the abort signal
      // This prevents the Promise from resolving, keeping 'running' status as true
      // The channel will stop when stopAccount() is called or the abort signal is triggered
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => {
          console.log("XiaoYi: abort signal received, stopping channel");
          resolve();
        }, { once: true });

        // Also handle case where abort is already triggered
        if (ctx.abortSignal.aborted) {
          console.log("XiaoYi: abort signal already triggered");
          resolve();
        }
      });

      console.log("XiaoYi: startAccount() exiting - END");
    },

    stopAccount: async (ctx: ChannelGatewayContext<ResolvedXiaoYiAccount>) => {
      const runtime = getXiaoYiRuntime();
      runtime.stop();
    },
  },

  /**
   * Messaging adapter - normalize targets
   */
  messaging: {
    normalizeTarget: async (ctx: ChannelMessagingNormalizeTargetContext) => {
      // For XiaoYi, we use sessionId as the target
      // The sessionId comes from the incoming message's meta
      return ctx.to;
    },
  },

  /**
   * Status adapter - health checks
   */
  status: {
    getAccountStatus: async (ctx: ChannelStatusGetAccountStatusContext) => {
      const runtime = getXiaoYiRuntime();
      const connection = runtime.getConnection();

      if (!connection) {
        return {
          status: "offline",
          message: "Not connected",
        };
      }

      const state = connection.getState();

      if (state.connected && state.authenticated) {
        return {
          status: "online",
          message: "Connected and authenticated",
        };
      } else if (state.connected) {
        return {
          status: "connecting",
          message: "Connected but not authenticated",
        };
      } else {
        return {
          status: "offline",
          message: `Reconnect attempts: ${state.reconnectAttempts}/${state.maxReconnectAttempts}`,
        };
      }
    },
  },
};
