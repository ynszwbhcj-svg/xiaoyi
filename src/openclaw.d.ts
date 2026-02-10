// Type declarations for OpenClaw plugin API
// This file provides the necessary types for building the plugin

declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    runtime: any;
    registerChannel(options: { plugin: any }): void;
    registerTool(options: any): void;
    registerHook(options: any): void;
    registerService(options: any): void;
    registerGatewayMethod(options: any): void;
  }

  export function emptyPluginConfigSchema(): any;
}

declare module "openclaw" {
  export interface OpenClawPluginDefinition {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    kind?: "memory";
    configSchema?: any;
    register?: (api: OpenClawPluginApi) => void;
    activate?: (api: OpenClawPluginApi) => void;
  }

  export interface OpenClawPluginApi {
    runtime: any;
    registerChannel(options: { plugin: ChannelPlugin<any> }): void;
    registerTool(options: any): void;
    registerHook(options: any): void;
    registerService(options: any): void;
    registerGatewayMethod(options: any): void;
  }

  export interface ChannelPlugin<TAccount = any> {
    id: string;
    meta?: {
      name?: string;
      description?: string;
      icon?: string;
    };
    capabilities?: {
      chatTypes?: Array<"direct" | "group" | "channel" | "thread">;
      polls?: boolean;
      reactions?: boolean;
      threads?: boolean;
      media?: boolean;
      nativeCommands?: boolean;
    };
    config?: {
      listAccountIds?: (cfg: OpenClawConfig) => string[];
      resolveAccount?: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
      defaultAccountId?: (cfg: OpenClawConfig) => string | undefined;
      isConfigured?: (account: TAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
      isEnabled?: (account: TAccount, cfg: OpenClawConfig) => boolean;
      disabledReason?: (account: TAccount, cfg: OpenClawConfig) => string;
      unconfiguredReason?: (account: TAccount, cfg: OpenClawConfig) => string;
      setAccountEnabled?: (params: {
        cfg: OpenClawConfig;
        accountId: string;
        enabled: boolean;
      }) => OpenClawConfig;
      deleteAccount?: (params: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
      describeAccount?: (account: TAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot;
      resolveAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
      }) => string[] | undefined;
      formatAllowFrom?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        allowFrom: Array<string | number>;
      }) => string[];
    };
    outbound?: {
      deliveryMode?: "direct" | "gateway" | "hybrid";
      chunker?: ((text: string, limit: number) => string[]) | null;
      chunkerMode?: "text" | "markdown";
      textChunkLimit?: number;
      pollMaxOptions?: number;
      sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
      sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
      sendPoll?: (ctx: any) => Promise<any>;
      sendReaction?: (ctx: any) => Promise<OutboundDeliveryResult>;
    };
    gateway?: {
      startAccount?: (ctx: ChannelGatewayContext<TAccount>) => Promise<unknown>;
      stopAccount?: (ctx: ChannelGatewayContext<TAccount>) => Promise<void>;
      loginWithQrStart?: (params: {
        accountId?: string;
        force?: boolean;
        timeoutMs?: number;
        verbose?: boolean;
      }) => Promise<ChannelLoginWithQrStartResult>;
      loginWithQrWait?: (params: {
        accountId?: string;
        timeoutMs?: number;
      }) => Promise<ChannelLoginWithQrWaitResult>;
      logoutAccount?: (ctx: ChannelLogoutContext<TAccount>) => Promise<ChannelLogoutResult>;
    };
    messaging?: {
      normalizeTarget?: (ctx: ChannelMessagingNormalizeTargetContext) => Promise<string>;
    };
    status?: {
      getAccountStatus?: (ctx: ChannelStatusGetAccountStatusContext) => Promise<{ status: string; message: string }>;
    };
    configSchema?: any;
  }

  export interface ChannelConfigListAccountsContext {
    channelConfig: any;
  }

  export interface ChannelConfigResolveAccountContext {
    channelConfig: any;
    accountId?: string;
  }

  export interface ChannelOutboundContext {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    gifPlayback?: boolean;
    replyToId?: string | null;
    threadId?: string | number | null;
    accountId?: string | null;
    account?: any;
    deps?: any;
  }

  export interface OutboundDeliveryResult {
    channel: string;
    messageId: string;
    chatId?: string;
    channelId?: string;
    roomId?: string;
    conversationId?: string;
    timestamp?: number;
    toJid?: string;
    pollId?: string;
    meta?: Record<string, unknown>;
  }

  export interface ChannelGatewayContext<ResolvedAccount = unknown> {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime: RuntimeEnv;
    abortSignal: AbortSignal;
    log?: ChannelLogSink;
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (next: ChannelAccountSnapshot) => void;
  }

  export interface RuntimeEnv {
    channel: {
      reply: {
        handleInboundMessage: (message: InboundMessage) => Promise<void>;
      };
    };
    emit: (event: string, data: any) => void;
  }

  export interface ChannelLogSink {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  }

  export interface ChannelAccountSnapshot {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    linked?: boolean;
    running?: boolean;
    connected?: boolean;
    reconnectAttempts?: number;
    lastConnectedAt?: number | null;
    lastDisconnect?: string | { at: number; status?: number; error?: string; loggedOut?: boolean; } | null;
    lastMessageAt?: number | null;
    lastEventAt?: number | null;
    lastError?: string | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
    mode?: string;
    dmPolicy?: string;
    allowFrom?: string[];
    tokenSource?: string;
    botTokenSource?: string;
    appTokenSource?: string;
    credentialSource?: string;
    audienceType?: string;
    audience?: string;
    webhookPath?: string;
    webhookUrl?: string;
    baseUrl?: string;
    allowUnmentionedGroups?: boolean;
    cliPath?: string | null;
    dbPath?: string | null;
    port?: number | null;
    probe?: unknown;
    lastProbeAt?: number | null;
    audit?: unknown;
    application?: unknown;
    bot?: unknown;
  }

  export interface OpenClawConfig {
    channels?: Record<string, any>;
    [key: string]: any;
  }

  export interface ChannelMessagingNormalizeTargetContext {
    to: string;
  }

  export interface ChannelStatusGetAccountStatusContext {
    accountId: string;
  }

  export interface ChannelLoginWithQrStartResult {
    qrDataUrl?: string;
    message: string;
  }

  export interface ChannelLoginWithQrWaitResult {
    connected: boolean;
    message: string;
  }

  export interface ChannelLogoutContext<ResolvedAccount = unknown> {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime: RuntimeEnv;
    log?: ChannelLogSink;
  }

  export interface ChannelLogoutResult {
    cleared: boolean;
    loggedOut?: boolean;
    [key: string]: unknown;
  }

  export interface InboundMessage {
    channel: string;
    accountId: string;
    from: string;
    text: string;
    messageId: string;
    timestamp: number;
    peer: {
      kind: "dm" | "group" | "channel";
      id: string;
    };
    meta?: Record<string, any>;
  }
}
