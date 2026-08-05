# @ynhcj/xiaoyi

小艺开放平台的 OpenClaw Channel 插件。插件通过 WebSocket 接入小艺 A2A 消息流，将用户消息路由给 OpenClaw Agent，并把流式回复返回给小艺。

## 兼容版本

- OpenClaw：`>=2026.6.6 <2026.8.0`
- 最低版本构建基线：`openclaw@2026.6.6`
- Node.js：`>=22.22.3 <23`、`>=24.15.0 <25` 或 `>=25.9.0`

## 功能

- AK/SK 鉴权
- A2A JSON-RPC 消息收发
- 流式回复和任务状态更新
- WebSocket 心跳、断线重连和连接状态上报
- 文件消息下载和媒体上下文
- 同会话运行中消息可交给 OpenClaw `steer` 队列处理
- 清空上下文与取消任务
- OpenClaw 2026.6+ Plugin SDK 的 Channel 入口和配置向导

## 安装

```bash
openclaw plugins install @ynhcj/xiaoyi@latest
```

## 配置

先在小艺开放平台获取 AK、SK 和 Agent ID，然后在 `openclaw.json` 中添加：

```json
{
  "channels": {
    "xiaoyi": {
      "enabled": true,
      "ak": "小艺开放平台凭证 AK",
      "sk": "小艺开放平台凭证 SK",
      "agentId": "小艺开放平台 Agent ID"
    }
  }
}
```

`wsUrl1` 是可选配置。未设置时使用：

```text
wss://hag.cloud.huawei.com/openclaw/v1/ws/link
```

修改配置后重启网关：

```bash
openclaw gateway restart
```

可通过以下命令检查插件和 Channel 状态：

```bash
openclaw plugins inspect xiaoyi --runtime
openclaw channels status --channel xiaoyi
```

## 可选配置

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `wsUrl1` | 小艺 WebSocket 服务地址 | 小艺开放平台默认地址 |
| `enableStreaming` | 是否启用流式回复 | `true` |
| `apiId` | 推送通知 API ID | 无 |
| `pushId` | 推送通知 Push ID | 无 |
| `taskTimeoutMs` | 任务超时时间（毫秒） | `3600000` |
| `sessionCleanupTimeoutMs` | 会话延迟清理时间（毫秒） | `3600000` |

当前实现为单账号模式，OpenClaw 账号 ID 固定为 `default`。

## 本地开发

```bash
npm install
npm test
npm pack --dry-run
```

本地联调可以使用链接安装：

```bash
npm run build
openclaw plugins install -l .
openclaw gateway restart
```

如果已经安装过 npm 发布版，请改用本地目录覆盖安装：

```bash
openclaw plugins install . --force
openclaw gateway restart
```

## 协议

- A2A 消息流：小艺开放平台消息流协议
- 鉴权：使用 AK、SK 和时间戳生成签名
- 传输：WebSocket

## License

MIT
