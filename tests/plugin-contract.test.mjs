import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pluginDefinition from "../dist/index.js";
import { xiaoyiPlugin } from "../dist/channel.js";

test("exports a 2026.7 channel plugin entry", () => {
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

test("applies XiaoYi credentials through the 2026.7 setup adapter", () => {
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

test("declares the OpenClaw 2026.7.1 compatibility floor", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.devDependencies.openclaw, "2026.7.1-2");
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.7.1");
  assert.equal(packageJson.openclaw.build.openclawVersion, "2026.7.1");
  assert.equal(packageJson.openclaw.install.minHostVersion, ">=2026.7.1");

  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.channelConfigs.xiaoyi.schema.type, "object");
  assert.equal(manifest.channelConfigs.xiaoyi.uiHints.sk.sensitive, true);
});
