// Configuration parsing and validation for XiaoYi channel
import type { OpenClawConfig } from "openclaw/dist/plugin-sdk/index.js";
import type { XiaoYiChannelConfig } from "./types.js";

// Type alias for backward compatibility
type ClawdbotConfig = OpenClawConfig;

/**
 * Resolve XiaoYi channel configuration from OpenClaw config.
 */
export function resolveXYConfig(cfg: ClawdbotConfig): XiaoYiChannelConfig {
  const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;

  if (!channelConfig) {
    throw new Error("XiaoYi channel configuration not found");
  }

  return channelConfig;
}

/**
 * List XiaoYi channel account IDs.
 * Single account mode - always returns ["default"].
 */
export function listXYAccountIds(cfg: ClawdbotConfig): string[] {
  const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;

  if (!channelConfig || !channelConfig.enabled) {
    return [];
  }

  return ["default"];
}

/**
 * Get default XiaoYi channel account ID.
 * Single account mode - always returns "default".
 */
export function getDefaultXYAccountId(cfg: ClawdbotConfig): string | undefined {
  const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;

  if (!channelConfig || !channelConfig.enabled) {
    return undefined;
  }

  return "default";
}
