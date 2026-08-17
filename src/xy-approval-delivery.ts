import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import {
  clearPendingXYApproval,
  getPendingXYApproval,
} from "./xy-approval-manager.js";
import { sendA2AResponse, sendStatusUpdate } from "./xy-formatter.js";

export interface XYApprovalDeliveryDependencies {
  sendResponse: typeof sendA2AResponse;
  sendStatus: typeof sendStatusUpdate;
}

const defaultDependencies: XYApprovalDeliveryDependencies = {
  sendResponse: sendA2AResponse,
  sendStatus: sendStatusUpdate,
};

/**
 * Deliver an asynchronous OpenClaw approval follow-up into the A2A task that
 * was left in input-required state. Returns null when the session has no
 * pending approval task, allowing the caller to fall back to push delivery.
 */
export async function deliverPendingXYApprovalText(params: {
  sessionId: string;
  text: string;
  dependencies?: XYApprovalDeliveryDependencies;
}): Promise<OutboundDeliveryResult | null> {
  const pending = getPendingXYApproval(params.sessionId);
  if (!pending) {
    return null;
  }

  const dependencies = params.dependencies ?? defaultDependencies;

  // Deliver the result before the terminal status. XiaoYi mobile keeps the
  // live task in "working" when it receives completed with final=false, and
  // may ignore content sent after a terminal event.
  await dependencies.sendResponse({
    config: pending.config,
    sessionId: pending.sessionId,
    taskId: pending.taskId,
    messageId: pending.messageId,
    text: params.text,
    append: false,
    final: false,
  });
  await dependencies.sendStatus({
    config: pending.config,
    sessionId: pending.sessionId,
    taskId: pending.taskId,
    messageId: pending.messageId,
    text: "任务处理已完成~",
    state: "completed",
    final: true,
  });

  clearPendingXYApproval(pending.sessionId, pending.taskId);

  return {
    channel: "xiaoyi",
    messageId: pending.messageId,
    chatId: pending.sessionId,
    meta: {
      delivery: "a2a-approval-followup",
      taskId: pending.taskId,
    },
  };
}
