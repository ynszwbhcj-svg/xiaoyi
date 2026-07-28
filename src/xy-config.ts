// Configuration parsing and validation for XiaoYi channel
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { XiaoYiChannelConfig } from "./types.js";

/**
 * Resolve XiaoYi channel configuration from OpenClaw config.
 */
export function resolveXYConfig(cfg: OpenClawConfig): XiaoYiChannelConfig {
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
export function listXYAccountIds(cfg: OpenClawConfig): string[] {
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
export function getDefaultXYAccountId(cfg: OpenClawConfig): string | undefined {
  const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;

  if (!channelConfig || !channelConfig.enabled) {
    return undefined;
  }

  return "default";
}
