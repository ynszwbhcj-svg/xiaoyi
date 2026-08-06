import type {
  ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-outbound";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";

import {
  XiaoYiChannelConfig,
  XIAOYI_CHANNEL_ID,
} from "./types.js";
import { getLatestSessionContext } from "./xy-tools/session-manager.js";
import { xiaoyiSetupAdapter, xiaoyiSetupWizard } from "./setup.js";
import { deliverPendingXYApprovalText } from "./xy-approval-delivery.js";
import {
  clearPendingXYApproval,
  getLatestPendingXYApproval,
  getPendingXYApproval,
} from "./xy-approval-manager.js";

// Special marker for default push delivery when no target is specified (cron/announce mode)
const DEFAULT_PUSH_MARKER = "default";
const DEFAULT_ACCOUNT_ID = "default";

/**
 * Resolved XiaoYi account configuration (single account mode)
 */
export interface ResolvedXiaoYiAccount {
  accountId: string;
  config: XiaoYiChannelConfig;
  enabled: boolean;
  configured: boolean;
}

/**
 * XiaoYi Channel Plugin
 * Implements OpenClaw ChannelPlugin interface for XiaoYi A2A protocol
 * Single account mode only
 */
export const xiaoyiPlugin: ChannelPlugin<ResolvedXiaoYiAccount> = {
  id: XIAOYI_CHANNEL_ID,

  meta: {
    id: XIAOYI_CHANNEL_ID,
    label: "XiaoYi",
    selectionLabel: "XiaoYi (小艺)",
    docsPath: "/channels/xiaoyi",
    blurb: "小艺 A2A 协议支持，通过 WebSocket 连接。",
    aliases: ["xiaoyi"],
  },

  capabilities: {
    chatTypes: ["direct"] as Array<"direct" | "group" | "channel">,
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
          description: "WebSocket server URL",
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

  setup: xiaoyiSetupAdapter,
  setupWizard: xiaoyiSetupWizard,

  /**
   * Config adapter - single account mode
   */
  config: {
    listAccountIds: (cfg) => {
      const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;
      if (!channelConfig || !channelConfig.enabled) {
        return [];
      }
      return [DEFAULT_ACCOUNT_ID];
    },

    resolveAccount: (cfg) => {
      const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig | undefined;

      if (!channelConfig) {
        return {
          accountId: DEFAULT_ACCOUNT_ID,
          config: {
            enabled: false,
            wsUrl: "",
            wsUrl1: "",
            ak: "",
            sk: "",
            agentId: "",
          },
          enabled: false,
          configured: false,
        };
      }

      const configured = Boolean(
        channelConfig.ak?.trim() &&
          channelConfig.sk?.trim() &&
          channelConfig.agentId?.trim(),
      );
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        config: channelConfig,
        enabled: channelConfig.enabled !== false,
        configured,
      };
    },

    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    isConfigured: (account) => account.configured,

    isEnabled: (account) => account.enabled,

    disabledReason: () => "Channel is disabled in configuration",

    unconfiguredReason: () =>
      "Missing required configuration: ak, sk, or agentId (wsUrl1 is optional, default will be used)",

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: "XiaoYi",
      enabled: account.enabled,
      configured: account.configured,
    }),
  },

  /**
   * Gateway adapter - manage connections
   * Using xy-monitor for message handling (xy_channel architecture)
   */
  gateway: {
    startAccount: async (ctx) => {
      const { monitorXYProvider } = await import("./xy-monitor.js");
      const account = ctx.account;
      const setStatus = createAccountStatusSink({
        accountId: account.accountId,
        setStatus: ctx.setStatus,
      });

      console.log(`[xiaoyi] Starting xiaoyi channel with xy_monitor architecture`);
      console.log(`[xiaoyi] Account ID: ${account.accountId}`);
      console.log(`[xiaoyi] Agent ID: ${account.config.agentId}`);

      return monitorXYProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: account.accountId,
        setStatus,
      });
    },

    // The monitor owns transport cleanup and observes the gateway abort signal.
    stopAccount: async () => {},
  },

  /**
   * Outbound adapter - send messages via push
   */
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,

    resolveTarget: ({ to }) => {
      if (!to || to.trim() === "") {
        // OpenClaw 2026.6 loses the external plugin target on async approval
        // follow-ups. Recover the latest pending A2A task as a compatibility
        // fallback; OpenClaw 2026.7 supplies the session target directly.
        const pendingApproval = getLatestPendingXYApproval();
        if (pendingApproval) {
          const recoveredTarget = `${pendingApproval.sessionId}::${pendingApproval.taskId}`;
          console.log(`[xiaoyi.resolveTarget] Recovered pending approval target`);
          return { ok: true as const, to: recoveredTarget };
        }
        console.log(`[xiaoyi.resolveTarget] No target specified, using default push marker`);
        return { ok: true as const, to: DEFAULT_PUSH_MARKER };
      }

      const trimmedTo = to.trim();

      if (!trimmedTo.includes("::")) {
        console.log(`[xiaoyi.resolveTarget] Target "${trimmedTo}" missing taskId, looking up session context`);
        const sessionContext = getLatestSessionContext();
        if (sessionContext && sessionContext.sessionId === trimmedTo) {
          const enhancedTarget = `${trimmedTo}::${sessionContext.taskId}`;
          console.log(`[xiaoyi.resolveTarget] Enhanced target: ${enhancedTarget}`);
          return { ok: true as const, to: enhancedTarget };
        }
        console.log(`[xiaoyi.resolveTarget] Could not find matching session context for "${trimmedTo}"`);
      }

      return { ok: true as const, to: trimmedTo };
    },

    sendText: async (ctx): Promise<OutboundDeliveryResult> => {
      const { cfg, to, text } = ctx;

      console.log(`[xiaoyi.sendText] Called with: to=${to}, textLength=${text?.length || 0}`);

      const { resolveXYConfig } = await import("./xy-config.js");
      const { XiaoYiPushService } = await import("./push.js");
      const { configManager } = await import("./xy-utils/config-manager.js");

      const config = { ...resolveXYConfig(cfg) };

      // Resolve actual target (strip taskId portion if present)
      let actualTo = to;
      if (to === DEFAULT_PUSH_MARKER) {
        actualTo = config.defaultSessionId || "";
      } else if (to.includes("::")) {
        actualTo = to.split("::")[0];
      }

      // Exec approvals complete asynchronously after the inbound A2A request
      // has returned. Resume the original input-required task before using the
      // optional webhook push transport.
      const pendingApproval = getPendingXYApproval(actualTo);
      if (pendingApproval) {
        try {
          const delivered = await deliverPendingXYApprovalText({
            sessionId: actualTo,
            text,
          });
          if (delivered) {
            console.log(`[xiaoyi.sendText] Approval follow-up delivered to pending A2A task`);
            return delivered;
          }
        } catch (error) {
          console.warn(
            `[xiaoyi.sendText] A2A approval follow-up failed, trying push fallback: ${String(error)}`,
          );
        }
      }

      // Override pushId with dynamic per-session pushId if available
      const dynamicPushId = pendingApproval?.pushId || configManager.getPushId(actualTo);
      if (dynamicPushId) {
        config.pushId = dynamicPushId;
      }

      const pushService = new XiaoYiPushService(config);

      // Extract title (first line, up to 57 chars)
      const title = text.split("\n")[0].slice(0, 57);
      // Truncate content to 1000 chars
      const pushText = text.length > 1000 ? text.slice(0, 1000) : text;

      const sent = await pushService.sendPush(pushText, title);
      if (!sent) {
        throw new Error(
          "XiaoYi outbound delivery failed: no active approval task and push is unavailable",
        );
      }

      console.log(`[xiaoyi.sendText] Push sent successfully`);
      if (pendingApproval) {
        clearPendingXYApproval(actualTo, pendingApproval.taskId);
      }

      return {
        channel: "xiaoyi",
        messageId: Date.now().toString(),
        chatId: actualTo,
      };
    },

    sendMedia: async (): Promise<OutboundDeliveryResult> => {
      throw new Error("暂不支持文件回传");
    },
  },


  /**
   * Messaging adapter - normalize targets
   * In new openclaw version, normalizeTarget receives a string and returns a normalized string
   */
  messaging: {
    normalizeTarget: (raw: string) => {
      // For XiaoYi, we use sessionId as the target
      // The raw input is already the normalized target (sessionId)
      return raw;
    },
  },

  /**
   * Status adapter - health checks
   * Using buildAccountSnapshot for compatibility with new openclaw version
   */
  status: {
    buildAccountSnapshot: async (params) => {
      return {
        ...params.runtime,
        accountId: params.account.accountId,
        name: "XiaoYi",
        enabled: params.account.enabled,
        configured: params.account.configured,
      };
    },
  },
};
