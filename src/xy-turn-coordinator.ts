import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { XIAOYI_CHANNEL_ID, type XiaoYiChannelConfig } from "./types.js";

export type XYQueueMode = "steer" | "followup" | "collect" | "interrupt";

/**
 * Mirrors OpenClaw's channel/global/default precedence. Session `/queue`
 * overrides are intentionally left to OpenClaw's runtime lifecycle signals.
 */
export function resolveXYConfiguredQueueMode(cfg: OpenClawConfig): XYQueueMode {
  const queue = cfg.messages?.queue;
  const byChannel = queue?.byChannel as
    | Record<string, XYQueueMode | undefined>
    | undefined;
  return byChannel?.[XIAOYI_CHANNEL_ID] ?? queue?.mode ?? "steer";
}

export interface XYTurnTarget {
  config: XiaoYiChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
}

export interface XYTurnHandle {
  sessionId: string;
  turnId: string;
}

interface XYTurnState {
  target: XYTurnTarget;
  parentTurnId?: string;
  deliveryTarget?: XYTurnTarget;
  legacySteerFallback: boolean;
}

interface XYSessionTurns {
  order: string[];
  turns: Map<string, XYTurnState>;
  waiters: Set<() => void>;
}

const sessions = new Map<string, XYSessionTurns>();

function notifySession(session: XYSessionTurns): void {
  const waiters = [...session.waiters];
  session.waiters.clear();
  waiters.forEach((resolve) => resolve());
}

function removeTurn(sessionId: string, turnId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  session.turns.delete(turnId);
  session.order = session.order.filter((id) => id !== turnId);
  notifySession(session);
  if (session.order.length === 0) {
    sessions.delete(sessionId);
  }
}

function resolveRootTurnId(session: XYSessionTurns, turnId: string): string {
  let currentId = turnId;
  const visited = new Set<string>();
  while (!visited.has(currentId)) {
    visited.add(currentId);
    const parentTurnId = session.turns.get(currentId)?.parentTurnId;
    if (!parentTurnId || !session.turns.has(parentTurnId)) {
      return currentId;
    }
    currentId = parentTurnId;
  }
  return turnId;
}

export function registerXYTurn(
  target: XYTurnTarget,
  turnId: string,
  legacySteerFallback = false,
): XYTurnHandle {
  const session = sessions.get(target.sessionId) ?? {
    order: [],
    turns: new Map<string, XYTurnState>(),
    waiters: new Set<() => void>(),
  };
  const latestTurnId = session.order[session.order.length - 1];
  const parentTurnId = latestTurnId
    ? resolveRootTurnId(session, latestTurnId)
    : undefined;
  if (!session.turns.has(turnId)) {
    session.order.push(turnId);
  }
  session.turns.set(turnId, { target, parentTurnId, legacySteerFallback });
  sessions.set(target.sessionId, session);
  notifySession(session);
  return { sessionId: target.sessionId, turnId };
}

/** A real agent run means this turn was not adopted by the earlier run. */
export function markXYTurnStarted(handle: XYTurnHandle): void {
  const turn = sessions.get(handle.sessionId)?.turns.get(handle.turnId);
  if (turn) {
    turn.parentTurnId = undefined;
    const session = sessions.get(handle.sessionId);
    if (session) {
      notifySession(session);
    }
  }
}

/** Retarget the parent run only after OpenClaw accepts this turn as a steer. */
export function adoptXYSteerTurn(handle: XYTurnHandle): boolean {
  const session = sessions.get(handle.sessionId);
  const turn = session?.turns.get(handle.turnId);
  const parent = turn?.parentTurnId ? session?.turns.get(turn.parentTurnId) : undefined;
  if (!turn || !parent) {
    return false;
  }
  parent.deliveryTarget = turn.target;
  removeTurn(handle.sessionId, handle.turnId);
  return true;
}

function pendingLegacySteerChildren(
  session: XYSessionTurns,
  parentTurnId: string,
): Array<[string, XYTurnState]> {
  return session.order.flatMap((turnId) => {
    const turn = session.turns.get(turnId);
    return turn?.parentTurnId === parentTurnId && turn.legacySteerFallback
      ? [[turnId, turn] as [string, XYTurnState]]
      : [];
  });
}

function waitForSessionMutation(session: XYSessionTurns, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      session.waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    session.waiters.add(finish);
  });
}

/**
 * OpenClaw 2026.6 has no adoption callback. Once the parent run is finishing,
 * give a queued follow-up time to announce its own agent run. If it does not,
 * the remaining steer candidate belongs to the parent's fused model answer.
 */
export async function settleXYTurnTarget(
  handle: XYTurnHandle,
  legacySettleMs = 1500,
): Promise<XYTurnTarget | null> {
  const deadline = Date.now() + legacySettleMs;
  while (true) {
    const session = sessions.get(handle.sessionId);
    const turn = session?.turns.get(handle.turnId);
    if (!session || !turn) {
      return null;
    }
    const pending = pendingLegacySteerChildren(session, handle.turnId);
    if (pending.length === 0) {
      return turn.deliveryTarget ?? turn.target;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const latest = pending[pending.length - 1];
      turn.deliveryTarget = latest[1].target;
      pending.forEach(([turnId]) => removeTurn(handle.sessionId, turnId));
      return turn.deliveryTarget;
    }
    await waitForSessionMutation(session, remaining);
  }
}

export function resolveXYTurnTarget(handle: XYTurnHandle): XYTurnTarget | null {
  const turn = sessions.get(handle.sessionId)?.turns.get(handle.turnId);
  return turn?.deliveryTarget ?? turn?.target ?? null;
}

export function hasXYTurnParent(handle: XYTurnHandle): boolean {
  const turn = sessions.get(handle.sessionId)?.turns.get(handle.turnId);
  return Boolean(turn?.parentTurnId);
}

export function completeXYTurn(handle: XYTurnHandle): XYTurnTarget | null {
  const target = resolveXYTurnTarget(handle);
  removeTurn(handle.sessionId, handle.turnId);
  return target;
}

export function abandonXYTurn(handle: XYTurnHandle): void {
  removeTurn(handle.sessionId, handle.turnId);
}

export function clearXYTurns(sessionId?: string): void {
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      notifySession(session);
    }
    sessions.delete(sessionId);
    return;
  }
  sessions.forEach(notifySession);
  sessions.clear();
}

export function pendingXYTurnCount(sessionId: string): number {
  return sessions.get(sessionId)?.order.length ?? 0;
}
