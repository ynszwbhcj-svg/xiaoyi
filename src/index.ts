import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xiaoyiPlugin } from "./channel";
import { setXiaoYiRuntime } from "./runtime";

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
 *       "agentId": "your-agent-id",
 *       "enableStreaming": true
 *     }
 *   }
 * }
 *
 * Backward compatibility: Can use "wsUrl" instead of "wsUrl1" (wsUrl2 will use default)
 */
const plugin = {
  id: "xiaoyi",
  name: "XiaoYi Channel",
  description: "XiaoYi channel plugin with A2A protocol support",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    console.log("XiaoYi: register() called - START");

    // Set runtime for managing WebSocket connections
    setXiaoYiRuntime(api.runtime);
    console.log("XiaoYi: setXiaoYiRuntime() completed");

    // Clean up any existing connections from previous plugin loads
    const runtime = require("./runtime").getXiaoYiRuntime();
    console.log(`XiaoYi: Got runtime instance: ${runtime.getInstanceId()}, isConnected: ${runtime.isConnected()}`);
    if (runtime.isConnected()) {
      console.log("XiaoYi: Cleaning up existing connection from previous load");
      runtime.stop();
    }

    // Register the channel plugin
    console.log("XiaoYi: About to call registerChannel()");
    api.registerChannel({ plugin: xiaoyiPlugin });
    console.log("XiaoYi: registerChannel() completed");

    console.log("XiaoYi channel plugin registered - END");
  },
};

export default plugin;
