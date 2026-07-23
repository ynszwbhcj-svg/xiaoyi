import type {
  ChannelPlugin,
  ChannelAccountSnapshot,
} from "openclaw/plugin-sdk";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";

// Local type definition for outbound delivery result
// (matches openclaw's internal OutboundDeliveryResult type)
type OutboundDeliveryResult = {
  channel: string;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
};

import { getXiaoYiRuntime } from "./runtime.js";
import { xiaoyiOnboardingAdapter } from "./onboarding.js";
import {
  XiaoYiChannelConfig,
  A2ARequestMessage,
  A2AResponseMessage,
} from "./types.js";
import {
  extractTextFromUrl,
  isImageMimeType,
  isPdfMimeType,
  isTextMimeType,
  downloadAndSaveMediaList,
  buildXiaoYiMediaPayload,
} from "./xiaoyi-media.js";
import { getLatestSessionContext } from "./xy-tools/session-manager.js";

// Special marker for default push delivery when no target is specified (cron/announce mode)
const DEFAULT_PUSH_MARKER = "default";

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
    listAccountIds: (cfg: ClawdbotConfig) => {
      const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;
      if (!channelConfig || !channelConfig.enabled) {
        return [];
      }
      // Single account mode: always return "default"
      return ["default"];
    },

    resolveAccount: (cfg: ClawdbotConfig, accountId?: string | null) => {
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

    defaultAccountId: (cfg: ClawdbotConfig) => {
      const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;
      if (!channelConfig || !channelConfig.enabled) {
        return undefined;
      }
      // Single account mode: always return "default"
      return "default";
    },

    isConfigured: (account: any, cfg: ClawdbotConfig) => {
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

    isEnabled: (account: any, cfg: ClawdbotConfig) => {
      return account?.enabled !== false;
    },

    disabledReason: (account: any, cfg: ClawdbotConfig) => {
      return "Channel is disabled in configuration";
    },

    unconfiguredReason: (account: any, cfg: ClawdbotConfig) => {
      return "Missing required configuration: ak, sk, or agentId (wsUrl1/wsUrl2 are optional, defaults will be used)";
    },

    describeAccount: (account: any, cfg: ClawdbotConfig) => ({
      accountId: account.accountId,
      name: 'XiaoYi',
      enabled: account.enabled,
      configured: Boolean(
        account.config?.ak && account.config?.sk && account.config?.agentId
      ),
    }),
  },

  /**
   * Gateway adapter - manage connections
   * Using xy-monitor for message handling (xy_channel architecture)
   */
  gateway: {
    startAccount: async (ctx: any) => {
      console.log("XiaoYi: startAccount() called - START");
      const { monitorXYProvider } = await import("./xy-monitor.js");
      const account = ctx.account;
      const config = ctx.cfg;

      console.log(`[xiaoyi] Starting xiaoyi channel with xy_monitor architecture`);
      console.log(`[xiaoyi] Account ID: ${account.accountId}`);
      console.log(`[xiaoyi] Agent ID: ${account.config.agentId}`);

      return monitorXYProvider({
        config: config,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: account.accountId,
        setStatus: ctx.setStatus,
      });
    },

    stopAccount: async (ctx: any) => {
      const runtime = getXiaoYiRuntime();
      runtime.stop();
    },
  },

  /**
   * Outbound adapter - send messages via push
   */
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,

    resolveTarget: ({ cfg, to, accountId, mode }: any) => {
      if (!to || to.trim() === "") {
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

    sendText: async (ctx: any): Promise<OutboundDeliveryResult> => {
      const { cfg, to, text, accountId } = ctx as any;

      console.log(`[xiaoyi.sendText] Called with: to=${to}, textLength=${text?.length || 0}`);

      const { resolveXYConfig } = await import("./xy-config.js");
      const { XiaoYiPushService } = await import("./push.js");
      const { configManager } = await import("./xy-utils/config-manager.js");

      const config = { ...resolveXYConfig(cfg) };

      // Resolve actual target (strip taskId portion if present)
      let actualTo = to;
      if (to === DEFAULT_PUSH_MARKER) {
        actualTo = (config as any).defaultSessionId || "";
      } else if (to.includes("::")) {
        actualTo = to.split("::")[0];
      }

      // Override pushId with dynamic per-session pushId if available
      const dynamicPushId = configManager.getPushId(actualTo);
      if (dynamicPushId) {
        config.pushId = dynamicPushId;
      }

      const pushService = new XiaoYiPushService(config);

      // Extract title (first line, up to 57 chars)
      const title = text.split("\n")[0].slice(0, 57);
      // Truncate content to 1000 chars
      const pushText = text.length > 1000 ? text.slice(0, 1000) : text;

      await pushService.sendPush(pushText, title);

      console.log(`[xiaoyi.sendText] Push sent successfully`);

      return {
        channel: "xiaoyi",
        messageId: Date.now().toString(),
        chatId: actualTo,
      };
    },

    sendMedia: async (ctx: any): Promise<OutboundDeliveryResult> => {
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
    buildAccountSnapshot: async (params: {
      account: ResolvedXiaoYiAccount;
      cfg: ClawdbotConfig;
      runtime?: any;
      probe?: unknown;
      audit?: unknown;
    }) => {
      const runtime = getXiaoYiRuntime();
      const connection = runtime.getConnection();

      if (!connection) {
        return {
          accountId: params.account.accountId,
          state: "offline" as const,
          lastEventAt: Date.now(),
          issues: [{
            severity: "error" as const,
            message: "Not connected",
          }],
        };
      }

      const state = connection.getState();

      if (state.connected && state.authenticated) {
        return {
          accountId: params.account.accountId,
          state: "ready" as const,
          lastEventAt: Date.now(),
          lastInboundAt: Date.now(),
        };
      } else if (state.connected) {
        return {
          accountId: params.account.accountId,
          state: "authenticating" as const,
          lastEventAt: Date.now(),
          issues: [{
            severity: "warning" as const,
            message: "Connected but not authenticated",
          }],
        };
      } else {
        return {
          accountId: params.account.accountId,
          state: "offline" as const,
          lastEventAt: Date.now(),
          issues: [{
            severity: "error" as const,
            message: `Reconnect attempts: ${state.reconnectAttempts}/${state.maxReconnectAttempts}`,
          }],
        };
      }
    },
  },
};
