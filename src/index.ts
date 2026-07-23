import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
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
 *       "wsUrl2": "ws://localhost:8766/ws/link",
 *       "ak": "test_ak",
 *       "sk": "test_sk",
 *       "agentId": "your-agent-id"
 *     }
 *   }
 * }
 */
const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "xiaoyi",
  name: "XiaoYi Channel",
  description: "XiaoYi channel plugin with A2A protocol support",
  register(api: OpenClawPluginApi) {
    console.log("XiaoYi: register() called - START");

    // Store runtime for cross-module access
    setXYRuntime(api.runtime);
    console.log("XiaoYi: setXYRuntime() completed");

    // Register the channel plugin
    console.log("XiaoYi: About to call registerChannel()");
    api.registerChannel({ plugin: xiaoyiPlugin });
    console.log("XiaoYi: registerChannel() completed");

    console.log("XiaoYi channel plugin registered - END");
  },
});

export default plugin;
