import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pluginDefinition from "../dist/index.js";
import { xiaoyiPlugin } from "../dist/channel.js";
import { createXYMessageRunner } from "../dist/xy-message-runner.js";
import { shouldUseLegacyXYSteerDispatch } from "../dist/xy-bot.js";
import { buildXYInboundMessageId } from "../dist/xy-parser.js";
import {
  resolveXYNoReplyDisposition,
  shouldAdoptXYSteerTurn,
} from "../dist/xy-reply-dispatcher.js";
import {
  adoptXYSteerTurn,
  clearXYTurns,
  completeXYTurn,
  markXYTurnStarted,
  pendingXYTurnCount,
  registerXYTurn,
  resolveXYConfiguredQueueMode,
  resolveXYTurnTarget,
  settleXYTurnTarget,
} from "../dist/xy-turn-coordinator.js";
import { deliverPendingXYApprovalText } from "../dist/xy-approval-delivery.js";
import {
  buildXYApprovalPrompt,
  clearAllPendingXYApprovals,
  extractXYApprovalCommand,
  getLatestPendingXYApproval,
  getPendingXYApproval,
  isPendingXYApprovalCommand,
  isPendingXYApprovalText,
  pendingXYApprovalCount,
  registerPendingXYApproval,
} from "../dist/xy-approval-manager.js";
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

test("routes one adopted steer response to the latest XiaoYi task", () => {
  clearXYTurns();
  const config = { enabled: true, ak: "ak", sk: "sk", agentId: "agent" };
  const sports = registerXYTurn(
    { config, sessionId: "news", taskId: "sports-task", messageId: "sports-message" },
    "sports-turn",
  );
  const entertainment = registerXYTurn(
    {
      config,
      sessionId: "news",
      taskId: "entertainment-task",
      messageId: "entertainment-message",
    },
    "entertainment-turn",
  );

  assert.equal(resolveXYTurnTarget(sports)?.taskId, "sports-task");
  assert.equal(adoptXYSteerTurn(entertainment), true);
  assert.deepEqual(completeXYTurn(sports), {
    config,
    sessionId: "news",
    taskId: "entertainment-task",
    messageId: "entertainment-message",
  });
  assert.equal(pendingXYTurnCount("news"), 0);
});

test("uses XiaoYi channel queue mode before global mode and defaults to steer", () => {
  assert.equal(resolveXYConfiguredQueueMode({}), "steer");
  assert.equal(
    resolveXYConfiguredQueueMode({ messages: { queue: { mode: "followup" } } }),
    "followup",
  );
  assert.equal(
    resolveXYConfiguredQueueMode({
      messages: {
        queue: { mode: "followup", byChannel: { xiaoyi: "steer" } },
      },
    }),
    "steer",
  );
});

test("bypasses legacy dispatch admission only for overlapping steer turns", () => {
  const base = { hasParentTurn: true, configuredQueueMode: "steer" };
  for (const hostVersion of [
    "2026.6.6",
    "2026.6.10",
    "2026.7.0",
  ]) {
    assert.equal(
      shouldUseLegacyXYSteerDispatch({ ...base, hostVersion }),
      true,
      `${hostVersion} should use legacy steer admission`,
    );
  }
  for (const hostVersion of ["2026.7.1", "2026.7.1-2", "2026.7.20"]) {
    assert.equal(
      shouldUseLegacyXYSteerDispatch({ ...base, hostVersion }),
      false,
      `${hostVersion} should use native queued dispatch admission`,
    );
  }
  assert.equal(
    shouldUseLegacyXYSteerDispatch({
      ...base,
      hostVersion: "2026.6.6",
      configuredQueueMode: "followup",
    }),
    false,
  );
  assert.equal(
    shouldUseLegacyXYSteerDispatch({
      ...base,
      hostVersion: "2026.6.6",
      hasParentTurn: false,
    }),
    false,
  );
});

test("falls back to the latest fused steer target on OpenClaw 2026.6", async () => {
  clearXYTurns();
  const config = { enabled: true, ak: "ak", sk: "sk", agentId: "agent" };
  const sports = registerXYTurn(
    { config, sessionId: "legacy-news", taskId: "sports-task", messageId: "sports-message" },
    "sports-turn",
  );
  registerXYTurn(
    {
      config,
      sessionId: "legacy-news",
      taskId: "entertainment-task",
      messageId: "entertainment-message",
    },
    "entertainment-turn",
    true,
  );

  assert.equal((await settleXYTurnTarget(sports, 0))?.taskId, "entertainment-task");
  assert.equal(completeXYTurn(sports)?.taskId, "entertainment-task");
  assert.equal(pendingXYTurnCount("legacy-news"), 0);
});

test("keeps followup runs as separate XiaoYi responses", () => {
  clearXYTurns();
  const config = { enabled: true, ak: "ak", sk: "sk", agentId: "agent" };
  const active = registerXYTurn(
    { config, sessionId: "news", taskId: "sports-task", messageId: "sports-message" },
    "sports-turn",
  );
  const followup = registerXYTurn(
    {
      config,
      sessionId: "news",
      taskId: "combined-task",
      messageId: "combined-message",
    },
    "entertainment-turn",
  );

  markXYTurnStarted(followup);
  assert.deepEqual(completeXYTurn(active), {
    config,
    sessionId: "news",
    taskId: "sports-task",
    messageId: "sports-message",
  });
  assert.deepEqual(completeXYTurn(followup), {
    config,
    sessionId: "news",
    taskId: "combined-task",
    messageId: "combined-message",
  });
});

test("distinguishes approval input when XiaoYi reuses the A2A message id", async () => {
  const base = {
    jsonrpc: "2.0",
    method: "message/stream",
    id: "task-1&1",
    params: {
      id: "task-1&1",
      sessionId: "session-1",
      message: {
        role: "user",
        parts: [{ kind: "text", text: "run a command" }],
      },
    },
  };
  const approval = {
    ...base,
    params: {
      ...base.params,
      message: {
        role: "user",
        parts: [{ kind: "text", text: "/approve abc123 allow-once" }],
      },
    },
  };

  const originalId = buildXYInboundMessageId(base);
  const approvalId = buildXYInboundMessageId(approval);
  assert.notEqual(originalId, approvalId);
  assert.equal(buildXYInboundMessageId(structuredClone(base)), originalId);

  const releases = [];
  const runner = createXYMessageRunner(() => {});
  const run = (label) =>
    runner.run(`session-1::${label}`, () => new Promise((resolve) => releases.push(resolve)));

  assert.equal(run(originalId), true);
  assert.equal(run(approvalId), true);
  assert.equal(run(approvalId), false);
  releases.forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.size(), 0);
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

test("adopts only a turn accepted by an existing run as steer", () => {
  assert.equal(
    shouldAdoptXYSteerTurn({ agentRunStarted: false, turnAdopted: true }),
    true,
  );
  assert.equal(
    shouldAdoptXYSteerTurn({ agentRunStarted: true, turnAdopted: true }),
    false,
  );
  assert.equal(
    shouldAdoptXYSteerTurn({ agentRunStarted: false, turnAdopted: false }),
    false,
  );
});

test("tracks an exec approval task until its asynchronous result is delivered", async () => {
  clearAllPendingXYApprovals();
  const config = { enabled: true, ak: "ak", sk: "sk", agentId: "agent" };
  registerPendingXYApproval({
    config,
    sessionId: "approval-session",
    taskId: "approval-task",
    messageId: "approval-message",
    approvalId: "approval-id",
    approvalSlug: "approval-slug",
  });

  const statuses = [];
  const responses = [];
  const result = await deliverPendingXYApprovalText({
    sessionId: "approval-session",
    text: "command completed",
    dependencies: {
      sendStatus: async (payload) => statuses.push(payload),
      sendResponse: async (payload) => responses.push(payload),
    },
  });

  assert.equal(result?.meta?.delivery, "a2a-approval-followup");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].state, "completed");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].text, "command completed");
  assert.equal(responses[0].final, true);
  assert.equal(getPendingXYApproval("approval-session"), null);
});

test("keeps a pending approval when A2A follow-up delivery fails", async () => {
  clearAllPendingXYApprovals();
  registerPendingXYApproval({
    config: { enabled: true, ak: "ak", sk: "sk", agentId: "agent" },
    sessionId: "failed-session",
    taskId: "failed-task",
    messageId: "failed-message",
  });

  await assert.rejects(() =>
    deliverPendingXYApprovalText({
      sessionId: "failed-session",
      text: "result",
      dependencies: {
        sendStatus: async () => {},
        sendResponse: async () => {
          throw new Error("socket unavailable");
        },
      },
    }),
  );
  assert.equal(pendingXYApprovalCount(), 1);
  clearAllPendingXYApprovals();
});

test("recognizes and renders manual approval commands", () => {
  assert.deepEqual(
    extractXYApprovalCommand("Reply with: /approve abc123 allow-once"),
    { approvalRef: "abc123", decision: "allow-once" },
  );
  const prompt = buildXYApprovalPrompt({
    approvalSlug: "abc123",
    command: "echo ok",
  });
  assert.match(prompt, /\/approve abc123 allow-once/);
  assert.match(prompt, /\/approve abc123 deny/);
  assert.equal(
    isPendingXYApprovalText("Approval required. Reply with: /approve abc123 allow-once"),
    true,
  );
  assert.equal(
    isPendingXYApprovalText("For example, type /approve abc123 allow-once in another chat."),
    false,
  );
});

test("recognizes only the approval command for the active pending task", () => {
  clearAllPendingXYApprovals();
  registerPendingXYApproval({
    config: { enabled: true, ak: "ak", sk: "sk", agentId: "agent" },
    sessionId: "approval-session",
    taskId: "approval-task",
    messageId: "approval-message",
    approvalId: "c81148c0-8bd8-4178-a0c9-fb22772bf879",
    approvalSlug: "c81148c0",
  });

  assert.equal(
    isPendingXYApprovalCommand(
      "approval-session",
      "/approve c81148c0 allow-once",
    ),
    true,
  );
  assert.equal(
    isPendingXYApprovalCommand("approval-session", "/approve stale-id allow-once"),
    false,
  );
  assert.equal(
    isPendingXYApprovalCommand("other-session", "/approve c81148c0 allow-once"),
    false,
  );
  clearAllPendingXYApprovals();
});

test("recovers the latest pending approval target for OpenClaw 2026.6", () => {
  clearAllPendingXYApprovals();
  registerPendingXYApproval({
    config: { enabled: true, ak: "ak", sk: "sk", agentId: "agent" },
    sessionId: "legacy-session",
    taskId: "legacy-task",
    messageId: "legacy-message",
    registeredAt: 1,
    expiresAt: Date.now() + 60_000,
  });

  assert.equal(getLatestPendingXYApproval()?.sessionId, "legacy-session");
  assert.deepEqual(xiaoyiPlugin.outbound.resolveTarget({}), {
    ok: true,
    to: "legacy-session::legacy-task",
  });
  clearAllPendingXYApprovals();
});

test("does not report success when neither A2A nor push delivery is available", async () => {
  clearAllPendingXYApprovals();
  await assert.rejects(
    () =>
      xiaoyiPlugin.outbound.sendText({
        cfg: {
          channels: {
            xiaoyi: { enabled: true, ak: "ak", sk: "sk", agentId: "agent" },
          },
        },
        to: "session-without-push",
        text: "approval follow-up",
        accountId: "default",
      }),
    /push is unavailable/,
  );
});
