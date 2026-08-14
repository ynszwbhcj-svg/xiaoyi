// Message dispatch engine - following feishu/bot.ts pattern (simplified)
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getXYRuntime } from "./runtime.js";
import { createXYReplyDispatcher } from "./xy-reply-dispatcher.js";
import {
  buildXYInboundMessageId,
  parseA2AMessage,
  extractTextFromParts,
  extractFileParts,
  extractPushId,
  isClearContextMessage,
  isTasksCancelMessage,
} from "./xy-parser.js";
import { downloadFilesFromParts } from "./file-download.js";
import { resolveXYConfig } from "./xy-config.js";
import { sendStatusUpdate, sendClearContextResponse, sendTasksCancelResponse } from "./xy-formatter.js";
import { registerSession, unregisterSession } from "./xy-tools/session-manager.js";
import { configManager } from "./xy-utils/config-manager.js";
import { XIAOYI_CHANNEL_ID, type A2AJsonRpcRequest } from "./types.js";
import {
  clearPendingXYApproval,
  isPendingXYApprovalCommand,
} from "./xy-approval-manager.js";
import {
  clearXYTurns,
  hasXYTurnParent,
  registerXYTurn,
  resolveXYConfiguredQueueMode,
} from "./xy-turn-coordinator.js";

/**
 * Parameters for handling an XY message.
 */
export interface HandleXYMessageParams {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  message: A2AJsonRpcRequest;
  accountId: string;
  inboundMessageId?: string;
}

/**
 * OpenClaw 2026.7.1 added active-dispatch admission for channel-owned queued
 * follow-ups. Older supported hosts need to enter getReplyFromConfig directly
 * for an overlapping steer turn, otherwise dispatchReplyFromConfig waits for
 * the parent run and steer can never observe it as active.
 */
export function shouldUseLegacyXYSteerDispatch(params: {
  hostVersion: string;
  hasParentTurn: boolean;
  configuredQueueMode: ReturnType<typeof resolveXYConfiguredQueueMode>;
}): boolean {
  if (!params.hasParentTurn || params.configuredQueueMode !== "steer") {
    return false;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(params.hostVersion.trim());
  if (!match) {
    return false;
  }
  const [, year, month, patch] = match.map(Number);
  return (
    year < 2026 ||
    (year === 2026 && (month < 7 || (month === 7 && patch < 1)))
  );
}

/**
 * Turn a short steer interruption into an explicit extension of the active
 * request. Without this framing, prompts such as "还有娱乐新闻" can be treated
 * as a replacement and make the restarted model call forget the sports-news
 * portion that was already being processed.
 */
export function buildXYAgentInputText(params: {
  text: string;
  steerContinuation: boolean;
}): string {
  if (!params.steerContinuation || !params.text.trim()) {
    return params.text;
  }

  return [
    "这是对当前正在处理请求的补充要求。请保留原请求的目标和已获得的信息，将新增要求一起纳入当前任务，并重新生成一份统一、完整的最终答复。不要只回答新增要求，也不要把两段独立答案机械拼接。",
    "",
    `新增要求：${params.text}`,
  ].join("\n");
}

/**
 * Handle an incoming A2A message.
 * This is the main entry point for message processing.
 * Runtime is expected to be validated before calling this function.
 */
export async function handleXYMessage(params: HandleXYMessageParams): Promise<void> {
  const { cfg, runtime, message, accountId } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Get OpenClaw PluginRuntime via new runtime store
  const core = getXYRuntime();

  try {
    // Check for special messages BEFORE parsing (these have different param structures)
    const messageMethod = message.method;
    log(`[BOT-ENTRY] <<<<<<< Received message with method: ${messageMethod}, id: ${message.id} >>>>>>>`);

    // Handle clearContext messages (params only has sessionId)
    if (messageMethod === "clearContext" || messageMethod === "clear_context") {
      const sessionId = message.params?.sessionId;
      if (!sessionId) {
        throw new Error("clearContext request missing sessionId in params");
      }
      log(`Clear context request for session ${sessionId}`);
      const config = resolveXYConfig(cfg);
      clearPendingXYApproval(sessionId);
      clearXYTurns(sessionId);
      await sendClearContextResponse({
        config,
        sessionId,
        messageId: message.id,
      });
      return;
    }

    // Handle tasks/cancel messages
    if (messageMethod === "tasks/cancel" || messageMethod === "tasks_cancel") {
      const sessionId = message.params?.sessionId;
      const taskId = message.params?.id || message.id;
      if (!sessionId) {
        throw new Error("tasks/cancel request missing sessionId in params");
      }
      log(`Tasks cancel request for session ${sessionId}, task ${taskId}`);
      const config = resolveXYConfig(cfg);
      clearPendingXYApproval(sessionId);
      clearXYTurns(sessionId);
      await sendTasksCancelResponse({
        config,
        sessionId,
        taskId,
        messageId: message.id,
      });
      return;
    }

    // Parse the A2A message (for regular messages)
    const parsed = parseA2AMessage(message);

    // Extract and update push_id if present
    const pushId = extractPushId(parsed.parts);
    if (pushId) {
      log(`[BOT] 📌 Extracted push_id from user message`);
      log(`[BOT]   - Session ID: ${parsed.sessionId}`);
      configManager.updatePushId(parsed.sessionId, pushId);
    } else {
      log(`[BOT] ℹ️  No push_id found in message, will use config default`);
    }

    // Resolve configuration (needed for status updates)
    const config = resolveXYConfig(cfg);

    // ✅ Resolve agent route (following feishu pattern)
    // accountId is "default" for XY (single account mode)
    // Use sessionId as peer.id to ensure all messages in the same session share context
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: XIAOYI_CHANNEL_ID,
      accountId,  // "default"
      peer: {
        kind: "direct" as const,
        id: parsed.sessionId,  // ✅ Use sessionId to share context within the same conversation session
      },
    });

    log(`xy: resolved route accountId=${route.accountId}, sessionKey=${route.sessionKey}`);

    // Register session context for tools
    log(`[BOT] 📝 About to register session for tools...`);
    log(`[BOT]   - sessionKey: ${route.sessionKey}`);
    log(`[BOT]   - sessionId: ${parsed.sessionId}`);
    log(`[BOT]   - taskId: ${parsed.taskId}`);

    registerSession(route.sessionKey, {
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      agentId: route.agentId,
    });

    log(`[BOT] ✅ Session registered for tools`);

    // Send initial status update immediately after parsing message
    log(`[STATUS] Sending initial status update for session ${parsed.sessionId}`);
    void sendStatusUpdate({
      config,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      text: "任务正在处理中，请稍后~",
      state: "working",
    }).catch((err) => {
      error(`Failed to send initial status update:`, err);
    });

    // Extract text and files from parts
    const text = extractTextFromParts(parsed.parts);
    const fileParts = extractFileParts(parsed.parts);
    // XiaoYi reuses the original A2A task for `/approve`. The short OpenClaw
    // acknowledgement must not complete that task; the asynchronous exec
    // result will close it through the pending-approval delivery path.
    const approvalContinuation = isPendingXYApprovalCommand(parsed.sessionId, text);
    const configuredQueueMode = resolveXYConfiguredQueueMode(cfg);
    const turnHandle = approvalContinuation
      ? undefined
      : registerXYTurn(
          {
            config,
            sessionId: parsed.sessionId,
            taskId: parsed.taskId,
            messageId: parsed.messageId,
          },
          params.inboundMessageId ?? buildXYInboundMessageId(message),
          configuredQueueMode === "steer",
        );
    const steerContinuation = Boolean(
      turnHandle &&
        configuredQueueMode === "steer" &&
        hasXYTurnParent(turnHandle),
    );
    const agentInputText = buildXYAgentInputText({
      text,
      steerContinuation,
    });

    // Download files if present (using core's media download)
    const mediaList = await downloadFilesFromParts(fileParts);

    // Build media payload for inbound context (following feishu pattern)
    const mediaPayload = buildXYMediaPayload(mediaList);

    // Resolve envelope format options (following feishu pattern)
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with speaker prefix (following feishu pattern)
    let messageBody = agentInputText || "";

    // Add speaker prefix for clarity
    const speaker = parsed.sessionId;
    messageBody = `${speaker}: ${messageBody}`;

    // Format agent envelope (following feishu pattern)
    const body = core.channel.reply.formatAgentEnvelope({
      channel: XIAOYI_CHANNEL_ID,
      from: speaker,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    // ✅ Finalize inbound context (following feishu pattern)
    // Use route.accountId and route.sessionKey instead of parsed fields
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: text || "",
      CommandBody: text || "",
      From: parsed.sessionId,
      To: parsed.sessionId,  // ✅ Simplified: use sessionId as target (context is managed by SessionKey)
      SessionKey: route.sessionKey,  // ✅ Use route.sessionKey
      AccountId: route.accountId,  // ✅ Use route.accountId ("default")
      ChatType: "direct" as const,
      GroupSubject: undefined,
      SenderName: parsed.sessionId,
      SenderId: parsed.sessionId,
      Provider: XIAOYI_CHANNEL_ID,
      Surface: XIAOYI_CHANNEL_ID,
      // The A2A id remains unchanged for replies, but OpenClaw needs a content-
      // aware id because XiaoYi may reuse the task id for `/approve` input.
      MessageSid: params.inboundMessageId ?? buildXYInboundMessageId(message),
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: XIAOYI_CHANNEL_ID,
      OriginatingTo: parsed.sessionId,  // Original message target
      ReplyToBody: undefined, // A2A protocol doesn't support reply/quote
      ...mediaPayload,
    });

    // Create reply dispatcher (following feishu pattern)
    log(`[BOT-DISPATCHER] 🎯 Creating reply dispatcher for session=${parsed.sessionId}, taskId=${parsed.taskId}, messageId=${parsed.messageId}`);
    const {
      dispatcher,
      replyOptions,
      markDispatchIdle,
      markRunComplete,
      startStatusInterval,
      stopStatusInterval,
    } = createXYReplyDispatcher({
      cfg,
      runtime,
      sessionId: parsed.sessionId,
      taskId: parsed.taskId,
      messageId: parsed.messageId,
      accountId: route.accountId,  // ✅ Use route.accountId
      approvalContinuation,
      turnHandle,
    });
    log(`[BOT-DISPATCHER] ✅ Reply dispatcher created successfully`);

    // Start status update interval (will send updates every 60 seconds)
    // Interval will be automatically stopped when onIdle/onCleanup is triggered
    startStatusInterval();

    log(`xy: dispatching to agent (session=${parsed.sessionId})`);

    // Dispatch to OpenClaw core using correct API (following feishu pattern)
    log(`[BOT] 🚀 Starting dispatcher with session: ${route.sessionKey}`);

    const useLegacySteerDispatch = shouldUseLegacyXYSteerDispatch({
      hostVersion: core.version,
      hasParentTurn: Boolean(turnHandle && hasXYTurnParent(turnHandle)),
      configuredQueueMode,
    });

    try {
      await core.channel.reply.withReplyDispatcher({
        dispatcher,
        run: async () => {
          if (!useLegacySteerDispatch) {
            return core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyOptions,
            });
          }

          log(
            `[BOT] Using OpenClaw ${core.version} legacy steer admission for session ${route.sessionKey}`,
          );
          let queued = false;
          let completeQueuedTurn: (() => void) | undefined;
          const queuedTurnComplete = new Promise<void>((resolve) => {
            completeQueuedTurn = resolve;
          });
          const inheritedLifecycle = replyOptions.queuedFollowupLifecycle;
          const result = await getReplyFromConfig(
            ctxPayload,
            {
              ...replyOptions,
              queuedFollowupLifecycle: {
                onEnqueued: () => {
                  queued = true;
                  inheritedLifecycle?.onEnqueued?.();
                },
                onComplete: () => {
                  inheritedLifecycle?.onComplete?.();
                  completeQueuedTurn?.();
                },
              },
              onBlockReply: (payload) => {
                dispatcher.sendBlockReply(payload);
              },
            },
            cfg,
          );

          const replies = result ? (Array.isArray(result) ? result : [result]) : [];
          replies.forEach((payload) => dispatcher.sendFinalReply(payload));

          // A session-level /queue override may turn the configured steer into
          // a real queued follow-up. Keep this dispatcher alive until the core
          // finishes that run so its reply remains separate and deliverable.
          if (queued) {
            await queuedTurnComplete;
          }
        },
      });
    } finally {
      markRunComplete();
      markDispatchIdle();
      stopStatusInterval();
      unregisterSession(route.sessionKey, parsed.messageId);
    }

    log(`[BOT] ✅ Dispatcher completed for session: ${parsed.sessionId}`);
    log(`xy: dispatch complete (session=${parsed.sessionId})`);
  } catch (err) {
    // ✅ Only log error, don't re-throw to prevent gateway restart
    error("Failed to handle XY message:", err);
    runtime.error?.(`xy: Failed to handle message: ${String(err)}`);

    log(`[BOT] ❌ Error occurred, attempting cleanup...`);

    // Try to unregister session on error (if route was established)
    try {
      const core = getXYRuntime();
      const sessionId = message.params?.sessionId;
      if (sessionId) {
        log(`[BOT] 🧹 Cleaning up session after error: ${sessionId}`);

        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: XIAOYI_CHANNEL_ID,
          accountId,
          peer: {
            kind: "direct" as const,
            id: sessionId,  // ✅ Use sessionId for cleanup consistency
          },
        });

        log(`[BOT]   - Unregistering session: ${route.sessionKey}`);
        unregisterSession(route.sessionKey, message.id);
        log(`[BOT] ✅ Session unregistered after error`);
      }
    } catch (cleanupErr) {
      log(`[BOT] ⚠️  Cleanup failed:`, cleanupErr);
      // Ignore cleanup errors
    }

    // ❌ Don't re-throw: message processing error should not affect gateway stability
  }
}

/**
 * Build media payload for inbound context.
 * Following feishu pattern: buildFeishuMediaPayload().
 */
function buildXYMediaPayload(
  mediaList: Array<{ path: string; name: string; mimeType: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.mimeType).filter(Boolean);
  return {
    MediaPath: first?.path,
    MediaType: first?.mimeType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

/**
 * Infer OpenClaw media type from file type string.
 */
function inferMediaType(fileType: string): "image" | "video" | "audio" | "file" {
  const lower = fileType.toLowerCase();
  if (lower.includes("image") || /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(lower)) {
    return "image";
  }
  if (lower.includes("video") || /\.(mp4|avi|mov|mkv|webm)$/i.test(lower)) {
    return "video";
  }
  if (lower.includes("audio") || /\.(mp3|wav|ogg|m4a)$/i.test(lower)) {
    return "audio";
  }
  return "file";
}
