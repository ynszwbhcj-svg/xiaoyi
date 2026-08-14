// Reply dispatcher - adapted for OpenClaw 2026.6+ with streaming improvements
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { getXYRuntime } from "./runtime.js";

import {
  sendA2AResponse,
  sendReasoningTextUpdate,
  sendStatusUpdate,
} from "./xy-formatter.js";
import { resolveXYConfig } from "./xy-config.js";
import type { XiaoYiChannelConfig } from "./types.js";
import {
  buildXYApprovalPrompt,
  extractXYApprovalCommand,
  isPendingXYApprovalEvent,
  isPendingXYApprovalText,
  registerPendingXYApproval,
  type XYApprovalEvent,
} from "./xy-approval-manager.js";
import { configManager } from "./xy-utils/config-manager.js";
import {
  abandonXYTurn,
  adoptXYSteerTurn,
  completeXYTurn,
  hasXYTurnParent,
  markXYTurnStarted,
  resolveXYTurnTarget,
  settleXYTurnTarget,
  type XYTurnHandle,
  type XYTurnTarget,
} from "./xy-turn-coordinator.js";

export interface CreateXYReplyDispatcherParams {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  sessionId: string;
  taskId: string;
  messageId: string;
  accountId: string;
  approvalContinuation?: boolean;
  turnHandle?: XYTurnHandle;
}

type ReplyDispatcherWithTypingResult = ReturnType<
  PluginRuntime["channel"]["reply"]["createReplyDispatcherWithTyping"]
>;

export type XYReplyDispatcher = Omit<ReplyDispatcherWithTypingResult, "replyOptions"> & {
  replyOptions: GetReplyOptions;
  startStatusInterval: () => void;
  stopStatusInterval: () => void;
};

export type XYNoReplyDisposition = "deferred" | "failed";

export function resolveXYNoReplyDisposition(params: {
  agentRunStarted: boolean;
}): XYNoReplyDisposition {
  return params.agentRunStarted ? "failed" : "deferred";
}

export function shouldAdoptXYSteerTurn(params: {
  agentRunStarted: boolean;
  turnAdopted: boolean;
}): boolean {
  return params.turnAdopted && !params.agentRunStarted;
}

/**
 * Use OpenClaw's canonical final frame as the authoritative answer. A steer
 * can interrupt an earlier model call, so partial and block frames must never
 * be promoted or concatenated into the XiaoYi response body.
 */
export function resolveXYFinalReplyText(params: {
  finalReplyText: string;
}): string {
  // Partial and block replies are progress only. If OpenClaw does not provide
  // a canonical final frame, returning an empty final is safer than promoting
  // tool narration or an interrupted model call into the answer body.
  return params.finalReplyText;
}

/**
 * Create a reply dispatcher for XY channel messages.
 * Ported streaming improvements from xy_channel:
 * - processingLock: serialized promise chain to prevent concurrent WebSocket sends
 * - finalReplyText capture from deliver(kind: "final") for authoritative final frame
 */
export function createXYReplyDispatcher(
  params: CreateXYReplyDispatcherParams,
): XYReplyDispatcher {
  const {
    cfg,
    runtime,
    sessionId,
    taskId,
    messageId,
    accountId,
    approvalContinuation = false,
    turnHandle,
  } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`[DISPATCHER-CREATE] Creating dispatcher for session=${sessionId}, taskId=${taskId}`);

  // Get OpenClaw PluginRuntime via the 2026.6+ runtime store.
  const core = getXYRuntime();

  // Resolve configuration
  const config: XiaoYiChannelConfig = resolveXYConfig(cfg);
  const originalTarget: XYTurnTarget = { config, sessionId, taskId, messageId };
  const resolveTarget = () =>
    (turnHandle ? resolveXYTurnTarget(turnHandle) : null) ?? originalTarget;
  const sendResponse = (
    target: XYTurnTarget,
    payload: { text?: string; append: boolean; final: boolean },
  ) => sendA2AResponse({ ...target, ...payload });
  const sendStatus = (
    target: XYTurnTarget,
    payload: {
      text: string;
      state: "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "unknown";
    },
  ) => sendStatusUpdate({ ...target, ...payload });

  // Reply prefix context: not needed for bot-to-bot A2A channel
  const prefixContext = { responsePrefix: undefined, responsePrefixContextProvider: undefined, onModelSelected: undefined };

  // Status update interval (every 30 seconds)
  let statusUpdateInterval: NodeJS.Timeout | null = null;

  // Track state
  let hasSentResponse = false;
  let finalSent = false;
  let finalizationStarted = false;
  let agentRunStarted = false;
  let turnAdopted = false;
  let approvalPending = false;
  let approvalPromptText = "";
  let approvalStatusSent = false;

  // Streaming state (ported from xy_channel)
  let processingLock: Promise<void> = Promise.resolve();
  let finalReplyText = "";

  const startStatusInterval = () => {
    log(`[STATUS INTERVAL] Starting interval for session ${sessionId}`);
    statusUpdateInterval = setInterval(() => {
      void sendStatus(resolveTarget(), {
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

  const markApprovalPending = (params: XYApprovalEvent & { text?: string }): boolean => {
    const parsedCommand = extractXYApprovalCommand(params.text);
    if (!isPendingXYApprovalEvent(params) && !isPendingXYApprovalText(params.text)) {
      return false;
    }

    approvalPending = true;
    stopStatusInterval();
    approvalPromptText = params.text?.trim() || buildXYApprovalPrompt(params);
    registerPendingXYApproval({
      config,
      sessionId,
      taskId,
      messageId,
      approvalId: params.approvalId,
      approvalSlug: params.approvalSlug || parsedCommand?.approvalRef,
      pushId: configManager.getPushId(sessionId) ?? undefined,
    });
    return true;
  };

  const sendApprovalStatusOnce = async (): Promise<void> => {
    if (!approvalPending || approvalStatusSent) {
      return;
    }
    approvalStatusSent = true;
    try {
      await sendStatus(resolveTarget(), {
        text: approvalPromptText || "任务等待授权，请输入 /approve 命令。",
        state: "input-required",
      });
    } catch (err) {
      approvalStatusSent = false;
      throw err;
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
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
          markApprovalPending({ text });

          // Capture canonical final text
          if (info?.kind === "final") {
            finalReplyText = text;
            log(`[DELIVER] Captured final reply text, length=${finalReplyText.length}`);
          }

          // Skip empty messages
          if (!text.trim()) {
            return;
          }

          // onPartialReply handles visible progress. Non-final deliver frames
          // are observed only for lifecycle tracking and never become body text.
          hasSentResponse = true;
          log(`[DELIVER] Observed non-empty frame, length=${text.length}`);
        } catch (deliverError) {
          error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        try {
          runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
          stopStatusInterval();

          if (!hasSentResponse) {
            await sendStatus(resolveTarget(), {
              text: "处理失败，请稍后重试",
              state: "failed",
            });
          }
        } catch (statusError) {
          error(`Failed to send error status:`, statusError);
        }
      },

      onIdle: async () => {
        log(`[ON_IDLE] Reply idle for session ${sessionId}, hasSentResponse=${hasSentResponse}, finalSent=${finalSent}, agentRunStarted=${agentRunStarted}`);

        if (finalizationStarted || finalSent) {
          return;
        }

        const noReplyDisposition = resolveXYNoReplyDisposition({
          agentRunStarted,
        });

        finalizationStarted = true;

        try {
          if (approvalContinuation) {
            await processingLock;
            log(`[ON_IDLE] Suppressed approval acknowledgement; awaiting async exec result`);
            return;
          }

          if (approvalPending) {
            await processingLock;
            if (turnHandle) {
              abandonXYTurn(turnHandle);
            }
            await sendApprovalStatusOnce();
            log(`[ON_IDLE] Left task open while exec approval is pending`);
            return;
          }

          if (hasSentResponse && !finalSent) {
            // Wait for in-flight onPartialReply to complete
            await processingLock;

            // The final frame must be authored by the last model call. Earlier
            // interrupted text is useful only as transient streaming progress.
            const fullFinalText = resolveXYFinalReplyText({
              finalReplyText,
            });

            if (turnHandle) {
              await settleXYTurnTarget(turnHandle);
            }
            const completionTarget = turnHandle
              ? completeXYTurn(turnHandle)
              : originalTarget;
            if (!completionTarget) {
              throw new Error("XiaoYi turn target disappeared before final delivery");
            }
            await sendStatus(completionTarget, {
              text: "任务处理已完成~",
              state: "completed",
            });
            await sendResponse(completionTarget, {
              text: fullFinalText,
              append: !fullFinalText,
              final: true,
            });
            finalSent = true;
            log(`[ON_IDLE] Sent final response`);
          } else if (noReplyDisposition === "deferred") {
            // OpenClaw 2026.6+ returns without starting a second run when the
            // prompt is steered or queued behind an active session.
            const isAcceptedSteer = shouldAdoptXYSteerTurn({
              agentRunStarted,
              turnAdopted,
            });
            const adopted = isAcceptedSteer && turnHandle
              ? adoptXYSteerTurn(turnHandle)
              : false;
            if (adopted) {
              finalSent = true;
              log(`[ON_IDLE] Steered turn adopted; parent run will answer latest XiaoYi task`);
              return;
            }
            if (turnHandle && hasXYTurnParent(turnHandle)) {
              finalizationStarted = false;
              log(`[ON_IDLE] Deferred turn remains open pending steer/follow-up resolution`);
              return;
            }
            const completionTarget = turnHandle
              ? completeXYTurn(turnHandle)
              : originalTarget;
            if (completionTarget) {
              await sendStatus(completionTarget, {
                text: "消息已接收~",
                state: "completed",
              });
              await sendResponse(completionTarget, {
                text: "",
                append: true,
                final: true,
              });
            }
            finalSent = true;
            log(`[ON_IDLE] Closed deferred task without an active steer parent`);
          } else {
            log(`[ON_IDLE] No response sent, sending failure`);
            const completionTarget = turnHandle
              ? completeXYTurn(turnHandle)
              : originalTarget;
            if (completionTarget) {
              await sendStatus(completionTarget, {
                text: "任务处理中断了~",
                state: "failed",
              });
              await sendResponse(completionTarget, {
                text: "任务执行异常，请重试~",
                append: false,
                final: true,
              });
            }
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
      onAgentRunStart: () => {
        agentRunStarted = true;
        if (turnHandle) {
          markXYTurnStarted(turnHandle);
        }
      },
      onTurnAdopted: () => {
        turnAdopted = true;
      },
      // OpenClaw 2026.7.1+ uses the presence of this lifecycle to admit a
      // visible turn while another reply is active. The core can then apply
      // the configured steer/followup/collect policy instead of serializing
      // the entire dispatch before queue-mode resolution.
      queuedFollowupLifecycle: {
        onEnqueued: () => {
          log(`[QUEUE] Turn queued behind the active run for session ${sessionId}`);
        },
        onComplete: () => {
          log(`[QUEUE] Queued turn completed for session ${sessionId}`);
        },
      },

      onApprovalEvent: async (payload) => {
        if (!markApprovalPending(payload)) {
          return;
        }
        try {
          await sendApprovalStatusOnce();
        } catch (err) {
          error(`[APPROVAL] Failed to send input-required status:`, err);
        }
      },

      // Tool execution start callback
      onToolStart: async ({ name, phase }) => {
        if (phase === "start") {
          const toolName = name || "unknown";
          try {
            await sendStatus(resolveTarget(), {
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
        markApprovalPending({ text });

        try {
          if (text.length > 0 || hasMedia) {
            if (approvalContinuation) {
              return;
            }
            if (approvalPending) {
              await sendApprovalStatusOnce();
              return;
            }
            const resultText = text.length > 0 ? text : "工具执行完成";
            await sendStatus(resolveTarget(), {
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
        // This callback carries private model reasoning. Never forward it to
        // XiaoYi; visible progress comes exclusively from onPartialReply.
        const text = payload.text ?? "";
        log(`[REASONING STREAM] Received but not forwarded, length=${text.length}`);
      },

      // Partial reply streaming callback (real-time text streaming)
      onPartialReply: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (text.length === 0) return;

        markApprovalPending({ text });
        hasSentResponse = true;

        // Serialized promise chain to prevent concurrent sends
        const prevLock = processingLock;
        let releaseLock: () => void;
        processingLock = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });

        try {
          await prevLock;

          if (approvalContinuation || approvalPending) {
            return;
          }

          if (config.enableStreaming === false) {
            return;
          }

          // OpenClaw 2026.6 and 2026.7 both surface tool narration and search
          // progress through partial replies. Keep it in XiaoYi's progress
          // area; only deliver(kind="final") is allowed into the main body.
          await sendReasoningTextUpdate({
            ...resolveTarget(),
            text,
            append: false,
          });
        } catch (err) {
          error(`[PARTIAL-REPLY] Failed to send:`, err);
        } finally {
          releaseLock!();
        }
      },
    } as GetReplyOptions & {
      /** OpenClaw 2026.7.1 adoption signal; ignored safely by 2026.6.6. */
      onTurnAdopted?: () => void | Promise<void>;
    },
    markDispatchIdle,
    markRunComplete,
    startStatusInterval,
    stopStatusInterval,
  };
}
