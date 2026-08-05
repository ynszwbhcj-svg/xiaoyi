import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pluginDefinition from "../dist/index.js";
import { xiaoyiPlugin } from "../dist/channel.js";
import { createXYMessageRunner } from "../dist/xy-message-runner.js";
import { resolveXYNoReplyDisposition } from "../dist/xy-reply-dispatcher.js";
import {
  getLatestSessionContext,
  getSessionContext,
  registerSession,
  unregisterSession,
} from "../dist/xy-tools/session-manager.js";

test("exports an OpenClaw 2026.6+ channel plugin entry", () => {
  assert.equal(pluginDefinition.id, "xiaoyi");
  assert.equal(pluginDefinition.channelPlugin, xiaoyiPlugin);
  assert.equal(typeof pluginDefinition.setChannelRuntime, "function");
  assert.equal(xiaoyiPlugin.id, "xiaoyi");
  assert.equal(xiaoyiPlugin.meta.id, "xiaoyi");
  assert.equal(typeof xiaoyiPlugin.setup?.applyAccountConfig, "function");
  assert.equal(xiaoyiPlugin.setupWizard?.channel, "xiaoyi");
});

test("resolves the single default account and validates credentials", () => {
  const disabled = { channels: { xiaoyi: { enabled: false } } };
  assert.deepEqual(xiaoyiPlugin.config.listAccountIds(disabled), []);

  const configured = {
    channels: {
      xiaoyi: {
        enabled: true,
        ak: "ak-value",
        sk: "sk-value",
        agentId: "agent-value",
      },
    },
  };
  assert.deepEqual(xiaoyiPlugin.config.listAccountIds(configured), ["default"]);

  const account = xiaoyiPlugin.config.resolveAccount(configured);
  assert.equal(account.accountId, "default");
  assert.equal(account.enabled, true);
  assert.equal(account.configured, true);

  const incomplete = xiaoyiPlugin.config.resolveAccount({
    channels: {
      xiaoyi: {
        enabled: true,
        ak: "ak-value",
        sk: " ",
        agentId: "agent-value",
      },
    },
  });
  assert.equal(incomplete.configured, false);
});

test("applies XiaoYi credentials through the 2026.6+ setup adapter", () => {
  const input = {
    token: " ak-value ",
    secret: " sk-value ",
    userId: " agent-value ",
  };
  assert.equal(
    xiaoyiPlugin.setup.validateInput({
      cfg: {},
      accountId: "default",
      input,
    }),
    null,
  );

  const configured = xiaoyiPlugin.setup.applyAccountConfig({
    cfg: {},
    accountId: "default",
    input,
  });
  assert.deepEqual(configured.channels.xiaoyi, {
    enabled: true,
    ak: "ak-value",
    sk: "sk-value",
    agentId: "agent-value",
  });
});

test("declares the OpenClaw 2026.6.6 compatibility floor", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.devDependencies.openclaw, "2026.6.6");
  assert.equal(packageJson.peerDependencies.openclaw, ">=2026.6.6 <2026.8.0");
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.6.6");
  assert.equal(packageJson.openclaw.build.openclawVersion, "2026.6.6");
  assert.equal(packageJson.openclaw.install.minHostVersion, ">=2026.6.6");
  assert.equal(packageJson.dependencies["node-fetch"], undefined);

  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.channelConfigs.xiaoyi.schema.type, "object");
  assert.equal(manifest.channelConfigs.xiaoyi.uiHints.sk.sensitive, true);
});

test("loads the file download module with the Node.js native fetch runtime", async () => {
  const fileDownload = await import("../dist/file-download.js");
  assert.equal(typeof fileDownload.downloadFile, "function");
  assert.equal(typeof fileDownload.downloadFilesFromParts, "function");
});

test("forwards distinct same-session messages without waiting for the active task", async () => {
  const starts = [];
  const releases = new Map();
  const errors = [];
  const runner = createXYMessageRunner((error) => errors.push(error));
  const task = (id) => async () => {
    starts.push(id);
    await new Promise((resolve) => releases.set(id, resolve));
  };

  assert.equal(runner.run("session-1::message-1", task("message-1")), true);
  assert.equal(runner.run("session-1::message-2", task("message-2")), true);
  assert.deepEqual(starts, ["message-1", "message-2"]);
  assert.equal(runner.size(), 2);
  assert.equal(runner.run("session-1::message-2", task("duplicate")), false);

  releases.get("message-1")();
  releases.get("message-2")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.size(), 0);
  assert.deepEqual(errors, []);
});

test("keeps overlapping session contexts isolated by message id", () => {
  const base = {
    config: { enabled: true, ak: "ak", sk: "sk", agentId: "agent" },
    sessionId: "session-overlap",
    agentId: "main",
  };
  const first = { ...base, taskId: "task-1", messageId: "message-1" };
  const second = { ...base, taskId: "task-2", messageId: "message-2" };

  registerSession("route-overlap", first);
  registerSession("route-overlap", second);
  assert.equal(getSessionContext("route-overlap")?.messageId, "message-2");
  assert.equal(getLatestSessionContext()?.messageId, "message-2");

  unregisterSession("route-overlap", "message-2");
  assert.equal(getSessionContext("route-overlap")?.messageId, "message-1");
  unregisterSession("route-overlap", "message-1");
  assert.equal(getSessionContext("route-overlap"), null);
});

test("distinguishes deferred active-session input from a failed agent run", () => {
  assert.equal(
    resolveXYNoReplyDisposition({ agentRunStarted: false }),
    "deferred",
  );
  assert.equal(
    resolveXYNoReplyDisposition({ agentRunStarted: true }),
    "failed",
  );
});
