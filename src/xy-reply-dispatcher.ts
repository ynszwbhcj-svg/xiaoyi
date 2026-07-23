// Reply dispatcher - adapted for openclaw 6.6 with streaming improvements
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";

import { sendA2AResponse, sendStatusUpdate, sendReasoningTextUpdate } from "./xy-formatter.js";
import { resolveXYConfig } from "./xy-config.js";
import type { XiaoYiChannelConfig } from "./types.js";

export interface CreateXYReplyDispatcherParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  sessionId: string;
  taskId: string;
  messageId: string;
  accountId: string;
}

/**
 * Create a reply dispatcher for XY channel messages.
 * Ported streaming improvements from xy_channel for openclaw 6.6:
 * - processingLock: serialized promise chain to prevent concurrent WebSocket sends
 * - Model-call boundary detection via prevModelText/currentModelText
 * - finalReplyText capture from deliver(kind: "final") for authoritative final frame
 */
export function createXYReplyDispatcher(params: CreateXYReplyDispatcherParams): any {
  const { cfg, runtime, sessionId, taskId, messageId, accountId } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`[DISPATCHER-CREATE] Creating dispatcher for session=${sessionId}, taskId=${taskId}`);

  // Get OpenClaw PluginRuntime via runtime store (openclaw 6.6 pattern)
  const core = getXYRuntime() as any;

  // Resolve configuration
  const config: XiaoYiChannelConfig = resolveXYConfig(cfg);

  // Reply prefix context: not needed for bot-to-bot A2A channel
  const prefixContext = { responsePrefix: undefined, responsePrefixContextProvider: undefined, onModelSelected: undefined };

  // Status update interval (every 30 seconds)
  let statusUpdateInterval: NodeJS.Timeout | null = null;

  // Track state
  let hasSentResponse = false;
  let finalSent = false;
  let accumulatedText = "";

  // Streaming state (ported from xy_channel)
  let processingLock: Promise<void> = Promise.resolve();
  let finalReplyText = "";
  let prevModelText = "";
  let currentModelText = "";

  const startStatusInterval = () => {
    log(`[STATUS INTERVAL] Starting interval for session ${sessionId}`);
    statusUpdateInterval = setInterval(() => {
      void sendStatusUpdate({
        config,
        sessionId,
        taskId,
        messageId,
        text: "任务正在处理中，请稍后~",
        state: "working",
      }).catch((err) => {
        error(`Failed to send status update:`, err);
      });
    }, 30000);
  };

  const stopStatusInterval = () => {
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, accountId),

      onReplyStart: () => {
        log(`[REPLY START] Reply started for session ${sessionId}`);
      },

      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";

        log(`[DELIVER] sessionId=${sessionId}, info.kind=${info?.kind}, text.length=${text.length}`);

        try {
          // Capture canonical final text
          if (info?.kind === "final") {
            finalReplyText = text;
            log(`[DELIVER] Captured final reply text, length=${finalReplyText.length}`);
          }

          // Skip empty messages
          if (!text.trim()) {
            return;
          }

          // onPartialReply handles streaming; deliver just accumulates for fallback
          accumulatedText += text;
          hasSentResponse = true;
          log(`[DELIVER ACCUMULATE] Accumulated text, current length=${accumulatedText.length}`);
        } catch (deliverError) {
          error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        try {
          runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
          stopStatusInterval();

          if (!hasSentResponse) {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: "处理失败，请稍后重试",
              state: "failed",
            });
          }
        } catch (statusError) {
          error(`Failed to send error status:`, statusError);
        }
      },

      onIdle: async () => {
        log(`[ON_IDLE] Reply idle for session ${sessionId}, hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);

        try {
          if (hasSentResponse && !finalSent) {
            // Wait for in-flight onPartialReply to complete
            await processingLock;

            // Resolve final text: prefer canonical finalReplyText from deliver(kind: "final")
            let resolvedLastModelText = currentModelText;
            if (finalReplyText) {
              resolvedLastModelText = finalReplyText;
            }

            const sep = prevModelText ? "\n" : "";
            const fullFinalText = prevModelText + sep + resolvedLastModelText;

            // Reset for next turn
            prevModelText = "";
            currentModelText = "";

            // Send completion status
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: "任务处理已完成~",
              state: "completed",
            });

            // Send final response
            if (fullFinalText) {
              await sendA2AResponse({
                config,
                sessionId,
                taskId,
                messageId,
                text: fullFinalText,
                append: false,
                final: true,
              });
            } else {
              await sendA2AResponse({
                config,
                sessionId,
                taskId,
                messageId,
                text: "",
                append: true,
                final: true,
              });
            }
            finalSent = true;
            log(`[ON_IDLE] Sent final response`);
          } else {
            log(`[ON_IDLE] No response sent, sending failure`);
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: "任务处理中断了~",
              state: "failed",
            });
            await sendA2AResponse({
              config,
              sessionId,
              taskId,
              messageId,
              text: "任务执行异常，请重试~",
              append: false,
              final: true,
            });
            finalSent = true;
          }
        } catch (err) {
          error(`[ON_IDLE] Failed to send final response:`, err);
        } finally {
          stopStatusInterval();
        }
      },

      onCleanup: () => {
        log(`[ON_CLEANUP] Reply cleanup for session ${sessionId}`);
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      suppressTyping: true,
      suppressToolErrorWarnings: true,
      onModelSelected: prefixContext.onModelSelected,

      // Tool execution start callback
      onToolStart: async ({ name, phase }) => {
        if (phase === "start") {
          const toolName = name || "unknown";
          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: `正在使用工具: ${toolName}...`,
              state: "working",
            });
          } catch (err) {
            error(`[TOOL START] Failed to send tool start status:`, err);
          }
        }
      },

      // Tool execution result callback
      onToolResult: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

        try {
          if (text.length > 0 || hasMedia) {
            const resultText = text.length > 0 ? text : "工具执行完成";
            await sendStatusUpdate({
              config,
              sessionId,
              taskId,
              messageId,
              text: resultText,
              state: "working",
            });
          }
        } catch (err) {
          error(`[TOOL RESULT] Failed to send tool result status:`, err);
        }
      },

      // Reasoning/thinking process streaming callback
      onReasoningStream: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        // Reasoning stream is received but not forwarded to A2A client
        // (uncomment below to enable reasoning text streaming)
        // if (text.length > 0) {
        //   try {
        //     await sendReasoningTextUpdate({ config, sessionId, taskId, messageId, text });
        //   } catch (err) {
        //     error(`[REASONING STREAM] Failed to send:`, err);
        //   }
        // }
      },

      // Partial reply streaming callback (real-time text streaming)
      onPartialReply: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (text.length === 0) return;

        hasSentResponse = true;

        // Serialized promise chain to prevent concurrent sends
        const prevLock = processingLock;
        let releaseLock: () => void;
        processingLock = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });

        try {
          await prevLock;

          // Model-call boundary detection: if current text doesn't begin
          // with what we accumulated for the current model call, we've
          // crossed a model-call boundary.
          if (currentModelText && !text.startsWith(currentModelText)) {
            prevModelText += (prevModelText ? "\n" : "") + currentModelText;
          }
          currentModelText = text;

          const sep = prevModelText ? "\n" : "";
          const fullText = prevModelText + sep + text;

          await sendA2AResponse({
            config,
            sessionId,
            taskId,
            messageId,
            text: fullText,
            append: false,
            final: false,
          });
        } catch (err) {
          error(`[PARTIAL-REPLY] Failed to send:`, err);
        } finally {
          releaseLock!();
        }
      },
    },
    markDispatchIdle,
    startStatusInterval,
    stopStatusInterval,
  };
}
