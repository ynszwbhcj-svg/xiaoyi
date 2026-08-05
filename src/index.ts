import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { xiaoyiPlugin } from "./channel.js";
import { setXYRuntime } from "./runtime.js";

/**
 * XiaoYi Channel Plugin for OpenClaw
 *
 * This plugin enables integration with XiaoYi's A2A protocol via WebSocket.
 * Supports dual server mode for high availability.
 *
 * Configuration example in openclaw.json:
 * {
 *   "channels": {
 *     "xiaoyi": {
 *       "enabled": true,
 *       "wsUrl1": "ws://localhost:8765/ws/link",
 *       "ak": "test_ak",
 *       "sk": "test_sk",
 *       "agentId": "your-agent-id"
 *     }
 *   }
 * }
 */
const plugin: OpenClawPluginDefinition = defineChannelPluginEntry({
  id: "xiaoyi",
  name: "XiaoYi Channel",
  description: "XiaoYi channel plugin with A2A protocol support",
  plugin: xiaoyiPlugin,
  setRuntime: setXYRuntime,
});

export default plugin;
