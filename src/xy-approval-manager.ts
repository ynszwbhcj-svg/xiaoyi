import type { XiaoYiChannelConfig } from "./types.js";

const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;
const APPROVE_COMMAND_PATTERN = /\/approve\s+([^\s`]+)\s+(allow-once|allow-always|deny)\b/i;
const APPROVAL_PENDING_TEXT_PATTERN =
  /approval(?: is)? required|approval-pending|reply with:|(?:需要|等待).{0,20}(?:批准|审批|授权|确认)/i;

export interface PendingXYApprovalTask {
  config: XiaoYiChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  approvalId?: string;
  approvalSlug?: string;
  pushId?: string;
  registeredAt: number;
  expiresAt: number;
}

export interface XYApprovalEvent {
  phase?: string;
  kind?: string;
  status?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  message?: string;
}

const pendingApprovals = new Map<string, PendingXYApprovalTask>();

function pruneExpired(now = Date.now()): void {
  for (const [sessionId, pending] of pendingApprovals) {
    if (pending.expiresAt <= now) {
      pendingApprovals.delete(sessionId);
    }
  }
}

export function extractXYApprovalCommand(text: string | undefined): {
  approvalRef: string;
  decision: "allow-once" | "allow-always" | "deny";
} | null {
  const match = text?.match(APPROVE_COMMAND_PATTERN);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    approvalRef: match[1],
    decision: match[2].toLowerCase() as "allow-once" | "allow-always" | "deny",
  };
}

export function isPendingXYApprovalEvent(event: XYApprovalEvent): boolean {
  return (
    event.phase?.toLowerCase() === "requested" &&
    event.status?.toLowerCase() === "pending" &&
    (!event.kind || event.kind.toLowerCase() === "exec")
  );
}

export function isPendingXYApprovalText(text: string | undefined): boolean {
  return Boolean(extractXYApprovalCommand(text) && text && APPROVAL_PENDING_TEXT_PATTERN.test(text));
}

function buildMarkdownCodeBlock(text: string, language = ""): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function extractXYApprovalPendingCommand(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const standardPendingCommand = text.match(
    /(?:pending command|待执行命令)\s*[:：]\s*\n+(`{3,})[^\n]*\n([\s\S]*?)\n\1/i,
  )?.[2]?.trim();
  if (standardPendingCommand) {
    return standardPendingCommand;
  }

  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const blockText = match[1]?.trim();
    if (blockText && !extractXYApprovalCommand(blockText)) {
      return blockText;
    }
  }

  return text
    .match(/(?:pending command|待执行命令)\s*[:：]\s*([^\n]+)/i)?.[1]
    ?.trim();
}

export function buildXYApprovalPrompt(params: {
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  message?: string;
}): string {
  const approvalRef = (params.approvalSlug || params.approvalId)
    ?.trim()
    .replace(/^`+|`+$/g, "");
  const lines = [params.message?.trim() || "执行该命令需要你的确认。"];

  if (params.command?.trim()) {
    lines.push(`待执行命令：\n\n${buildMarkdownCodeBlock(params.command.trim(), "sh")}`);
  }
  if (approvalRef) {
    lines.push(
      `允许本次执行：\n\n${buildMarkdownCodeBlock(`/approve ${approvalRef} allow-once`)}`,
    );
    lines.push(
      `始终允许执行：\n\n${buildMarkdownCodeBlock(`/approve ${approvalRef} allow-always`)}`,
    );
    lines.push(`拒绝执行：\n\n${buildMarkdownCodeBlock(`/approve ${approvalRef} deny`)}`);
  } else {
    lines.push("请使用 OpenClaw 返回的 /approve 命令完成确认。");
  }
  return lines.join("\n\n");
}

export function resolveXYApprovalPrompt(
  params: XYApprovalEvent & { text?: string },
): string {
  const rawText = params.text?.trim();
  const parsedCommand = extractXYApprovalCommand(rawText);
  const approvalRef = params.approvalSlug || params.approvalId || parsedCommand?.approvalRef;

  if (!approvalRef) {
    return rawText || buildXYApprovalPrompt(params);
  }

  return buildXYApprovalPrompt({
    approvalSlug: approvalRef,
    command: params.command?.trim() || extractXYApprovalPendingCommand(rawText),
    message: params.message,
  });
}

export function registerPendingXYApproval(
  task: Omit<PendingXYApprovalTask, "registeredAt" | "expiresAt"> & {
    registeredAt?: number;
    expiresAt?: number;
  },
): PendingXYApprovalTask {
  pruneExpired();
  const registeredAt = task.registeredAt ?? Date.now();
  const pending: PendingXYApprovalTask = {
    ...task,
    registeredAt,
    expiresAt: task.expiresAt ?? registeredAt + DEFAULT_APPROVAL_TTL_MS,
  };
  // Refresh Map insertion order so the latest fallback remains deterministic.
  pendingApprovals.delete(task.sessionId);
  pendingApprovals.set(task.sessionId, pending);
  return pending;
}

export function getPendingXYApproval(sessionId: string): PendingXYApprovalTask | null {
  pruneExpired();
  return pendingApprovals.get(sessionId) ?? null;
}

export function isPendingXYApprovalCommand(sessionId: string, text: string | undefined): boolean {
  const command = extractXYApprovalCommand(text);
  const pending = getPendingXYApproval(sessionId);
  if (!command || !pending) {
    return false;
  }

  const refs = [pending.approvalSlug, pending.approvalId].filter(
    (ref): ref is string => Boolean(ref),
  );
  return refs.some(
    (ref) => ref === command.approvalRef || ref.startsWith(command.approvalRef),
  );
}

export function getLatestPendingXYApproval(): PendingXYApprovalTask | null {
  pruneExpired();
  let latest: PendingXYApprovalTask | null = null;
  for (const pending of pendingApprovals.values()) {
    if (!latest || pending.registeredAt >= latest.registeredAt) {
      latest = pending;
    }
  }
  return latest;
}

export function clearPendingXYApproval(sessionId: string, taskId?: string): boolean {
  const pending = pendingApprovals.get(sessionId);
  if (!pending || (taskId && pending.taskId !== taskId)) {
    return false;
  }
  return pendingApprovals.delete(sessionId);
}

export function clearAllPendingXYApprovals(): void {
  pendingApprovals.clear();
}

export function pendingXYApprovalCount(): number {
  pruneExpired();
  return pendingApprovals.size;
}
