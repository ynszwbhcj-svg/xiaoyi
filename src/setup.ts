import type {
  ChannelSetupAdapter,
  ChannelSetupInput,
  ChannelSetupWizard,
  OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import type { XiaoYiChannelConfig } from "./types.js";

const CHANNEL_ID = "xiaoyi";
const DEFAULT_ACCOUNT_ID = "default";

function resolveConfig(cfg: OpenClawConfig): XiaoYiChannelConfig | undefined {
  return cfg.channels?.xiaoyi as XiaoYiChannelConfig | undefined;
}

function isConfigured(cfg: OpenClawConfig): boolean {
  const config = resolveConfig(cfg);
  return Boolean(config?.ak?.trim() && config.sk?.trim() && config.agentId?.trim());
}

function patchConfig(
  cfg: OpenClawConfig,
  patch: Partial<XiaoYiChannelConfig>,
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      xiaoyi: {
        ...resolveConfig(cfg),
        enabled: true,
        ...patch,
      },
    },
  } as OpenClawConfig;
}

export const xiaoyiSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  validateInput: ({ input }) => {
    if (!input.token?.trim()) {
      return "XiaoYi requires an Access Key (AK).";
    }
    if (!input.secret?.trim()) {
      return "XiaoYi requires a Secret Key (SK).";
    }
    if (!input.userId?.trim()) {
      return "XiaoYi requires an Agent ID.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, input }) => {
    const setupInput = input as ChannelSetupInput;
    return patchConfig(cfg, {
      ak: setupInput.token?.trim(),
      sk: setupInput.secret?.trim(),
      agentId: setupInput.userId?.trim(),
    });
  },
};

const setupHelp = [
  "请先在小艺开放平台创建应用并获取 AK、SK 和 Agent ID。",
  "插件通过 WebSocket 连接小艺开放平台；服务地址通常无需手工配置。",
];

export const xiaoyiSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL_ID,
  status: {
    configuredLabel: "XiaoYi configured",
    unconfiguredLabel: "XiaoYi needs AK, SK, and Agent ID",
    configuredHint: "configured",
    unconfiguredHint: "needs credentials",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isConfigured(cfg),
    resolveStatusLines: ({ cfg, configured }) => {
      const config = resolveConfig(cfg);
      if (!configured) {
        return ["XiaoYi: needs AK, SK, and Agent ID"];
      }
      return [
        `XiaoYi: ${config?.enabled === false ? "disabled" : "enabled"}`,
        `Agent ID: ${config?.agentId ?? "unknown"}`,
      ];
    },
  },
  introNote: {
    title: "XiaoYi setup",
    lines: setupHelp,
    shouldShow: ({ cfg }) => !isConfigured(cfg),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: CHANNEL_ID,
      credentialLabel: "XiaoYi Access Key (AK)",
      helpTitle: "XiaoYi credentials",
      helpLines: setupHelp,
      envPrompt: "Use XIAOYI_AK from the environment?",
      keepPrompt: "Keep the existing XiaoYi AK?",
      inputPrompt: "Enter XiaoYi Access Key (AK)",
      allowEnv: () => false,
      inspect: ({ cfg }) => {
        const config = resolveConfig(cfg);
        const value = config?.ak?.trim();
        return {
          accountConfigured: isConfigured(cfg),
          hasConfiguredValue: Boolean(value),
          resolvedValue: value || undefined,
        };
      },
      applySet: ({ cfg, resolvedValue }) => patchConfig(cfg, { ak: resolvedValue }),
    },
    {
      inputKey: "secret",
      providerHint: CHANNEL_ID,
      credentialLabel: "XiaoYi Secret Key (SK)",
      helpTitle: "XiaoYi credentials",
      helpLines: setupHelp,
      envPrompt: "Use XIAOYI_SK from the environment?",
      keepPrompt: "Keep the existing XiaoYi SK?",
      inputPrompt: "Enter XiaoYi Secret Key (SK)",
      allowEnv: () => false,
      inspect: ({ cfg }) => {
        const config = resolveConfig(cfg);
        const value = config?.sk?.trim();
        return {
          accountConfigured: isConfigured(cfg),
          hasConfiguredValue: Boolean(value),
          resolvedValue: value || undefined,
        };
      },
      applySet: ({ cfg, resolvedValue }) => patchConfig(cfg, { sk: resolvedValue }),
    },
  ],
  textInputs: [
    {
      inputKey: "userId",
      message: "Enter XiaoYi Agent ID",
      required: true,
      currentValue: ({ cfg }) => resolveConfig(cfg)?.agentId?.trim() || undefined,
      validate: ({ value }) => (value.trim() ? undefined : "Agent ID is required."),
      normalizeValue: ({ value }) => value.trim(),
      applySet: ({ cfg, value }) => patchConfig(cfg, { agentId: value }),
    },
  ],
  disable: (cfg) => {
    const config = resolveConfig(cfg);
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        xiaoyi: {
          ...config,
          enabled: false,
        },
      },
    } as OpenClawConfig;
  },
};
