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
  extractImageFromUrl,
  extractTextFromUrl,
  isImageMimeType,
  isPdfMimeType,
  isTextMimeType,
  type InputImageContent,
} from "./file-handler";

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
      await runtime.start(resolvedAccount.config);

      // Setup message handler IMMEDIATELY after connection is established
      const connection = runtime.getConnection();
      if (!connection) {
        throw new Error("Failed to get WebSocket connection after start");
      }

      // Setup message handler
      connection.on("message", async (message: A2ARequestMessage) => {
        // CRITICAL: Use dynamic require to get the latest runtime module after hot-reload
        const { getXiaoYiRuntime } = require("./runtime");
        const runtime = getXiaoYiRuntime();

        console.log(`XiaoYi: [Message Handler] Using runtime instance: ${runtime.getInstanceId()}`);

        // For message/stream, prioritize params.sessionId, fallback to top-level sessionId
        const sessionId = message.params?.sessionId || message.sessionId;

        // Validate sessionId exists
        if (!sessionId) {
          console.error("XiaoYi: Missing sessionId in message, cannot process");
          return;
        }

        // Store sessionId -> taskId mapping in runtime (use params.id as taskId)
        runtime.setTaskIdForSession(sessionId, message.params.id);

        // Get PluginRuntime from our runtime wrapper
        const pluginRuntime = runtime.getPluginRuntime();
        if (!pluginRuntime) {
          console.error("PluginRuntime not available");
          return;
        }

        // Extract text, file, and image content from parts array
        let bodyText = "";
        let images: InputImageContent[] = [];
        let fileAttachments: string[] = [];

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
              // Handle image files
              if (isImageMimeType(mimeType)) {
                console.log(`XiaoYi: Processing image file: ${name} (${mimeType})`);
                const imageContent = await extractImageFromUrl(uri, {
                  maxBytes: 10_000_000, // 10MB
                  timeoutMs: 30_000,     // 30 seconds
                });
                images.push(imageContent);
                fileAttachments.push(`[图片: ${name}]`);
                console.log(`XiaoYi: Successfully processed image: ${name}`);
              }
              // Handle PDF files - extract as text for now
              else if (isPdfMimeType(mimeType)) {
                console.log(`XiaoYi: Processing PDF file: ${name}`);
                // Note: PDF text extraction requires pdfjs-dist, for now just add a placeholder
                fileAttachments.push(`[PDF文件: ${name} - PDF内容提取需要额外配置]`);
                console.log(`XiaoYi: PDF file noted: ${name} (text extraction requires pdfjs-dist)`);
              }
              // Handle text-based files
              else if (isTextMimeType(mimeType)) {
                console.log(`XiaoYi: Processing text file: ${name} (${mimeType})`);
                const textContent = await extractTextFromUrl(uri, 5_000_000, 30_000);
                bodyText += `\n\n[文件内容: ${name}]\n${textContent}`;
                fileAttachments.push(`[文件: ${name}]`);
                console.log(`XiaoYi: Successfully processed text file: ${name}`);
              } else {
                console.warn(`XiaoYi: Unsupported file type: ${mimeType}, name: ${name}`);
                fileAttachments.push(`[不支持的文件类型: ${name} (${mimeType})]`);
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
        if (images.length > 0) {
          console.log(`XiaoYi: Total ${images.length} image(s) extracted for AI processing`);
        }

        // Determine sender ID from role
        const senderId = message.params.message.role === "user" ? "user" : message.agentId;

        // Build MsgContext for OpenClaw's message pipeline
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
        };

        // Dispatch message using OpenClaw's reply dispatcher
        try {
          console.log("\n" + "=".repeat(60));
          console.log(`XiaoYi: [MESSAGE] Processing user message`);
          console.log(`  Session: ${sessionId}`);
          console.log(`  Task ID: ${message.params.id}`);
          console.log(`  User input: ${bodyText.substring(0, 50)}${bodyText.length > 50 ? "..." : ""}`);
          console.log(`  Images: ${images.length}`);
          console.log("=".repeat(60) + "\n");

          // Get taskId from runtime's session mapping (must exist - was set when message received)
          const taskId = runtime.getTaskIdForSession(sessionId);
          if (!taskId) {
            console.error(`[ERROR] No taskId found for session ${sessionId}. Cannot process message.`);
            return;
          }
          const startTime = Date.now();
          let accumulatedText = "";
          let sentTextLength = 0; // Track sent text length for streaming
          let hasSentFinal = false; // Track if final content has been sent (to prevent duplicate isFinal=true)

          // ==================== CREATE ABORT CONTROLLER ====================
          // Create AbortController for this session to allow cancelation
          const { controller: abortController, signal: abortSignal } =
            runtime.createAbortControllerForSession(sessionId);
          // ================================================================

          // ==================== START TIMEOUT PROTECTION ====================
          // Start 60-second timeout timer (one-time only)
          const timeoutConfig = runtime.getTimeoutConfig();
          console.log(`[TIMEOUT] Starting ${timeoutConfig.duration}ms timeout protection for session ${sessionId}`);

          // Define one-time timeout handler (does not restart)
          const createTimeoutHandler = (): (() => Promise<void>) => {
            return async () => {
              const elapsed = Date.now() - startTime;
              console.log("\n" + "=".repeat(60));
              console.log(`[TIMEOUT] Timeout triggered for session ${sessionId}`);
              console.log(`  Elapsed: ${elapsed}ms`);
              console.log(`  Task ID: ${taskId}`);
              console.log("=".repeat(60) + "\n");

              const conn = runtime.getConnection();
              if (conn) {
                try {
                  // Send status update instead of artifact-update to keep conversation active
                  await conn.sendStatusUpdate(taskId, sessionId, timeoutConfig.message);
                  console.log(`[TIMEOUT] Status update sent successfully to session ${sessionId} (one-time)\n`);
                } catch (error) {
                  console.error(`[TIMEOUT] Failed to send status update:`, error);
                }
              } else {
                console.error(`[TIMEOUT] Connection not available, cannot send status update\n`);
              }
              // Note: Timeout is NOT restarted - only one timeout message per request
            };
          };

          // Start one-time timeout
          runtime.setTimeoutForSession(sessionId, createTimeoutHandler());
          // ==================== END TIMEOUT PROTECTION ====================

          await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: msgContext,
            cfg: config,
            dispatcherOptions: {
              deliver: async (payload: any, info: { kind: "tool" | "block" | "final" }) => {
                const elapsed = Date.now() - startTime;
                const completeText = payload.text || "";
                accumulatedText = completeText;
                const kind = info.kind; // "tool" | "block" | "final"

                // ==================== DEBUG LOG - ENTRY POINT ====================
                // Log EVERY call to deliver with full details
                console.log("\n" + "█".repeat(70));
                console.log(`📨 [DELIVER ENTRY] deliver() callback invoked`);
                console.log(`  Session: ${sessionId}`);
                console.log(`  Elapsed: ${elapsed}ms`);
                console.log(`  Kind: "${kind}"`);
                console.log(`  Text length: ${completeText.length} chars`);
                console.log(`  Sent so far: ${sentTextLength} chars`);
                if (completeText.length > 0) {
                  console.log(`  Text preview: "${completeText.substring(0, 80)}${completeText.length > 80 ? "..." : ""}"`);
                }
                console.log(`  Full info object:`, JSON.stringify(info, null, 2));
                console.log(`  Full payload keys:`, Object.keys(payload));
                console.log("█".repeat(70) + "\n");
                // =================================================================

                // Check if session was aborted
                if (runtime.isSessionAborted(sessionId)) {
                  console.log("\n" + "=".repeat(60));
                  console.log(`[ABORT] Response received AFTER abort`);
                  console.log(`  Session: ${sessionId}`);
                  console.log(`  Kind: ${kind}`);
                  console.log(`  Elapsed: ${elapsed}ms`);
                  console.log(`  Action: DISCARDING (session was canceled)`);
                  console.log("=".repeat(60) + "\n");
                  return;
                }

                // ==================== CHECK TIMEOUT ====================
                // If timeout already sent, discard this response
                if (runtime.isSessionTimeout(sessionId)) {
                  console.log("\n" + "=".repeat(60));
                  console.log(`[TIMEOUT] Response received AFTER timeout`);
                  console.log(`  Session: ${sessionId}`);
                  console.log(`  Kind: ${kind}`);
                  console.log(`  Elapsed: ${elapsed}ms`);
                  console.log(`  Action: DISCARDING (timeout message already sent)`);
                  console.log("=".repeat(60) + "\n");
                  return;
                }

                // ==================== CHECK EMPTY RESPONSE ====================
                // If response is empty, don't clear timeout (let it trigger)
                if (!completeText || completeText.length === 0) {
                  console.log("\n" + "=".repeat(60));
                  console.log(`[STREAM] Empty ${kind} response detected`);
                  console.log(`  Session: ${sessionId}`);
                  console.log(`  Elapsed: ${elapsed}ms`);
                  console.log(`  Action: SKIPPING (empty response)`);
                  console.log("=".repeat(60) + "\n");
                  // Don't send anything, and don't clear timeout
                  return;
                }

                const conn = runtime.getConnection();
                if (!conn) {
                  console.error(`✗ XiaoYi: Connection not available\n`);
                  return;
                }

                // ==================== STREAMING LOGIC ====================
                // For "block" kind: send incremental text (streaming)
                // For "final" kind: send complete text (final message)
                if (kind === "block") {
                  // Calculate incremental text
                  const incrementalText = completeText.slice(sentTextLength);

                  if (incrementalText.length > 0) {
                    console.log("\n" + "-".repeat(60));
                    console.log(`XiaoYi: [STREAM] Incremental block received`);
                    console.log(`  Session: ${sessionId}`);
                    console.log(`  Elapsed: ${elapsed}ms`);
                    console.log(`  Total length: ${completeText.length} chars`);
                    console.log(`  Incremental: +${incrementalText.length} chars (sent: ${sentTextLength})`);
                    console.log(`  Preview: "${incrementalText.substring(0, 50)}${incrementalText.length > 50 ? "..." : ""}"`);
                    console.log("-".repeat(60) + "\n");

                    const response: A2AResponseMessage = {
                      sessionId: sessionId,
                      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      timestamp: Date.now(),
                      agentId: resolvedAccount.config.agentId,
                      sender: {
                        id: resolvedAccount.config.agentId,
                        name: "OpenClaw Agent",
                        type: "agent",
                      },
                      content: {
                        type: "text",
                        text: incrementalText,
                      },
                      status: "success",
                    };

                    // Send incremental text, NOT final, append mode
                    await conn.sendResponse(response, taskId, sessionId, false, true);
                    console.log(`✓ XiaoYi: Stream chunk sent (+${incrementalText.length} chars)\n`);

                    // Update sent length
                    sentTextLength = completeText.length;
                  } else {
                    console.log("\n" + "-".repeat(60));
                    console.log(`XiaoYi: [STREAM] No new text to send`);
                    console.log(`  Session: ${sessionId}`);
                    console.log(`  Total length: ${completeText.length} chars`);
                    console.log(`  Already sent: ${sentTextLength} chars`);
                    console.log("-".repeat(60) + "\n");
                  }
                } else if (kind === "final") {
                  console.log("\n" + "=".repeat(60));
                  console.log(`XiaoYi: [STREAM] Final response received`);
                  console.log(`  Session: ${sessionId}`);
                  console.log(`  Elapsed: ${elapsed}ms`);
                  console.log(`  Total length: ${completeText.length} chars`);
                  console.log(`  Has already sent final: ${hasSentFinal}`);
                  console.log(`  Preview: "${completeText.substring(0, 100)}..."`);
                  console.log("=".repeat(60) + "\n");

                  // Check if we've already sent final content - prevent duplicate isFinal=true
                  if (hasSentFinal) {
                    console.log(`XiaoYi: [STREAM] Skipping duplicate final response (already sent)\n`);
                    // Don't send anything, but clear timeout to prevent timeout warnings
                    runtime.clearSessionTimeout(sessionId);
                    return;
                  }

                  const response: A2AResponseMessage = {
                    sessionId: sessionId,
                    messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: Date.now(),
                    agentId: resolvedAccount.config.agentId,
                    sender: {
                      id: resolvedAccount.config.agentId,
                      name: "OpenClaw Agent",
                      type: "agent",
                    },
                    content: {
                      type: "text",
                      text: completeText,
                    },
                    status: "success",
                  };

                  // Send complete text but NOT as final yet - use append mode to keep stream alive
                  // The true isFinal=true will be sent in onIdle callback
                  await conn.sendResponse(response, taskId, sessionId, false, true);
                  console.log(`✓ XiaoYi: Final response content sent (${completeText.length} chars, stream kept alive)\n`);

                  // Mark that we've sent the final content
                  hasSentFinal = true;

                  // Clear timeout to prevent timeout warnings, but don't mark session as completed yet
                  runtime.clearSessionTimeout(sessionId);

                  // Note: We DON'T call markSessionCompleted here
                  // The session will be marked completed in onIdle when we send isFinal=true
                } else if (kind === "tool") {
                  // Tool results - typically not sent as messages
                  console.log("\n" + "-".repeat(60));
                  console.log(`XiaoYi: [STREAM] Tool result received (not forwarded)`);
                  console.log(`  Session: ${sessionId}`);
                  console.log(`  Elapsed: ${elapsed}ms`);
                  console.log("-".repeat(60) + "\n");
                }
              },
              onIdle: async () => {
                const elapsed = Date.now() - startTime;
                console.log("\n" + "=".repeat(60));
                console.log(`XiaoYi: [IDLE] Processing complete`);
                console.log(`  Total time: ${elapsed}ms`);
                console.log(`  Final length: ${accumulatedText.length} chars`);
                console.log(`  Has sent final: ${hasSentFinal}`);

                // Only send final close message if we have valid content
                if (accumulatedText.length > 0) {
                  const conn = runtime.getConnection();
                  if (conn) {
                    try {
                      // Send the true final response with isFinal=true to properly close the stream
                      const finalResponse: A2AResponseMessage = {
                        sessionId: sessionId,
                        messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        timestamp: Date.now(),
                        agentId: resolvedAccount.config.agentId,
                        sender: {
                          id: resolvedAccount.config.agentId,
                          name: "OpenClaw Agent",
                          type: "agent",
                        },
                        content: {
                          type: "text",
                          text: accumulatedText,
                        },
                        status: "success",
                      };

                      // Send with isFinal=true to properly close the A2A communication stream
                      await conn.sendResponse(finalResponse, taskId, sessionId, true, false);
                      console.log(`✓ XiaoYi: True isFinal=true sent to close stream\n`);
                    } catch (error) {
                      console.error(`✗ XiaoYi: Failed to send final close message:`, error);
                    }
                  }

                  // Now mark session as completed and clean up
                  runtime.markSessionCompleted(sessionId);
                  runtime.clearAbortControllerForSession(sessionId);
                  console.log(`[TIMEOUT] Session completed and cleaned up\n`);
                } else {
                  console.log(`[TIMEOUT] No valid response, keeping timeout active\n`);
                }
                console.log("=".repeat(60) + "\n");
              },
            },
            replyOptions: {
              abortSignal: abortSignal,  // Pass abort signal to allow cancellation
            },
            images: images.length > 0 ? images : undefined,
          });
        } catch (error) {
          console.error("XiaoYi: [ERROR] Error dispatching message:", error);
          // Clear timeout on error
          runtime.clearSessionTimeout(sessionId);
          // Clear abort controller on error
          runtime.clearAbortControllerForSession(sessionId);
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

        // Clear timeout as the session is being canceled
        runtime.markSessionCompleted(sessionId);
      });

      console.log("XiaoYi: Event handlers registered");
      console.log("XiaoYi: startAccount() completed - END");
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
