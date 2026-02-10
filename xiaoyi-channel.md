# OpenClaw XiaoYi Channel 实现详解

本文档详细解释 openclaw-xiaoyi-channel 的实现，重点讲解 WebSocket 长连接维持、消息转换与发送的实现，以及如何接入 OpenClaw 的消息处理体系。

## 一、整体架构概览

openclaw-xiaoyi-channel 是一个 OpenClaw 的插件，用于接入华为小艺的 A2A (Agent-to-Agent) 协议。整体架构分为以下几层：

```
┌─────────────────────────────────────┐
│   OpenClaw 核心框架                  │
│   (消息路由、会话管理、Agent调度)     │
└──────────────┬──────────────────────┘
               │ Plugin API
┌──────────────▼──────────────────────┐
│   XiaoYi Channel Plugin (index.ts)  │
│   - 注册 channel                     │
│   - 设置 runtime                     │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Channel Adapter (channel.ts)      │
│   - config: 账号配置管理             │
│   - outbound: 消息发送               │
│   - gateway: 连接管理                │
│   - messaging: 目标规范化            │
│   - status: 状态查询                 │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Runtime Manager (runtime.ts)      │
│   - 管理多账号连接                   │
│   - 事件分发                         │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   WebSocket Manager (websocket.ts)  │
│   - WebSocket 连接维持               │
│   - 心跳机制                         │
│   - 自动重连                         │
│   - 消息收发                         │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Auth Module (auth.ts)             │
│   - AK/SK 签名生成                   │
│   - 认证消息构造                     │
└─────────────────────────────────────┘
```

### 核心模块说明

- **index.ts**: 插件入口，负责向 OpenClaw 注册 channel 插件
- **channel.ts**: Channel 适配器，实现 OpenClaw 的 ChannelPlugin 接口
- **runtime.ts**: 运行时管理器，管理多个账号的 WebSocket 连接
- **websocket.ts**: WebSocket 管理器，处理底层连接、心跳、重连
- **auth.ts**: 认证模块，生成 AK/SK 签名
- **types.ts**: 类型定义，包含 A2A 协议消息结构

## 二、WebSocket 长连接维持机制

### 2.1 连接建立流程

在 `websocket.ts:36-68` 中实现了连接建立过程：

```typescript
async connect(): Promise<void> {
  // 1. 防止重复连接
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    return;
  }

  try {
    // 2. 创建 WebSocket 实例
    this.ws = new WebSocket(this.config.wsUrl);
    this.setupWebSocketHandlers();  // 设置事件监听器

    // 3. 使用 Promise 包装异步连接过程
    return new Promise((resolve, reject) => {
      // 10秒超时保护
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 10000);

      // 4. 连接成功处理
      this.ws!.once("open", () => {
        clearTimeout(timeout);
        this.state.connected = true;
        this.state.reconnectAttempts = 0;  // 重置重连计数
        this.emit("connected");
        this.authenticate();  // 立即发起认证
        resolve();
      });

      // 5. 连接失败处理
      this.ws!.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } catch (error) {
    this.emit("error", error);
    throw error;
  }
}
```

**连接建立关键点：**

1. **防重复连接**: 检查现有连接状态，避免重复建立
2. **超时保护**: 10 秒超时机制，防止连接挂起
3. **状态管理**: 连接成功后重置重连计数器
4. **立即认证**: 连接建立后立即发起 AK/SK 认证

### 2.2 心跳机制实现

心跳机制是维持长连接的核心，在 `websocket.ts:220-234` 实现：

```typescript
private startHeartbeat(): void {
  this.heartbeatInterval = setInterval(() => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // 1. 发送 WebSocket ping 帧
      this.ws.ping();

      // 2. 检测心跳超时 (60秒未收到 pong)
      const now = Date.now();
      if (this.state.lastHeartbeat > 0 &&
          now - this.state.lastHeartbeat > 60000) {
        console.warn("Heartbeat timeout, reconnecting...");
        this.disconnect();
        this.scheduleReconnect();  // 触发重连
      }
    }
  }, 30000);  // 每30秒发送一次 ping
}
```

**心跳机制的关键点：**

1. **双重保活**: 使用 WebSocket 原生的 ping/pong 机制
2. **超时检测**: 如果 60 秒内没收到 pong 响应，认为连接已断开
3. **自动恢复**: 检测到超时后自动触发重连流程
4. **定时发送**: 每 30 秒发送一次 ping 帧

在 `websocket.ts:154-156` 处理 pong 响应：

```typescript
this.ws.on("pong", () => {
  this.state.lastHeartbeat = Date.now();  // 更新最后心跳时间
});
```

**心跳时序图：**

```
Client                          Server
  |                               |
  |-------- ping (30s) --------->|
  |                               |
  |<------- pong ----------------|
  |  (更新 lastHeartbeat)         |
  |                               |
  |-------- ping (30s) --------->|
  |                               |
  |  (60s 未收到 pong)            |
  |  触发重连                     |
```

### 2.3 自动重连机制

重连机制采用**指数退避算法**，在 `websocket.ts:246-266` 实现：

```typescript
private scheduleReconnect(): void {
  // 1. 检查是否达到最大重连次数 (10次)
  if (this.state.reconnectAttempts >= this.state.maxReconnectAttempts) {
    console.error("Max reconnection attempts reached");
    this.emit("maxReconnectAttemptsReached");
    return;
  }

  // 2. 计算退避延迟: min(1000 * 2^n, 30000)
  // 第1次: 2秒, 第2次: 4秒, 第3次: 8秒... 最大30秒
  const delay = Math.min(
    1000 * Math.pow(2, this.state.reconnectAttempts),
    30000
  );
  this.state.reconnectAttempts++;

  console.log(`Scheduling reconnect attempt ${this.state.reconnectAttempts} in ${delay}ms`);

  // 3. 延迟后尝试重连
  this.reconnectTimeout = setTimeout(async () => {
    try {
      await this.connect();
    } catch (error) {
      console.error("Reconnection failed:", error);
      this.scheduleReconnect();  // 递归重试
    }
  }, delay);
}
```

**重连策略说明：**

| 重连次数 | 延迟时间 | 说明 |
|---------|---------|------|
| 1 | 2秒 | 2^0 * 1000ms |
| 2 | 4秒 | 2^1 * 1000ms |
| 3 | 8秒 | 2^2 * 1000ms |
| 4 | 16秒 | 2^3 * 1000ms |
| 5 | 30秒 | min(2^4 * 1000ms, 30000) |
| 6-10 | 30秒 | 达到上限 |

**重连触发时机** (在 `websocket.ts:140-147`):

```typescript
this.ws.on("close", (code: number, reason: Buffer) => {
  console.log(`XiaoYi WebSocket closed: ${code} ${reason.toString()}`);
  this.state.connected = false;
  this.state.authenticated = false;
  this.clearTimers();  // 清理心跳定时器
  this.emit("disconnected");
  this.scheduleReconnect();  // 自动触发重连
});
```

**连接状态机：**

```
┌─────────┐
│ 初始化   │
└────┬────┘
     │ connect()
     ▼
┌─────────┐
│ 连接中   │
└────┬────┘
     │ open event
     ▼
┌─────────┐     authenticate()     ┌─────────┐
│ 已连接   │─────────────────────>│ 已认证   │
└────┬────┘                        └────┬────┘
     │                                  │
     │ close event                      │ close event
     ▼                                  ▼
┌─────────┐                        ┌─────────┐
│ 断开连接 │<───────────────────────│ 断开连接 │
└────┬────┘                        └─────────┘
     │
     │ scheduleReconnect()
     │ (指数退避)
     ▼
┌─────────┐
│ 重连中   │
└────┬────┘
     │
     └──> 返回 "连接中" 状态
```

## 三、认证机制

### 3.1 AK/SK 签名生成

在 `auth.ts:38-43` 实现 HMAC-SHA256 签名：

```typescript
private generateSignature(timestamp: number): string {
  // 1. 构造待签名字符串
  const stringToSign = `ak=${this.ak}&timestamp=${timestamp}`;

  // 2. 使用 SK 作为密钥，生成 HMAC-SHA256 签名
  const hmac = crypto.createHmac("sha256", this.sk);
  hmac.update(stringToSign);

  // 3. 返回十六进制格式的签名
  return hmac.digest("hex");
}
```

**签名算法说明：**

1. **待签名字符串格式**: `ak={AK}&timestamp={TIMESTAMP}`
2. **签名算法**: HMAC-SHA256
3. **密钥**: 使用 Secret Key (SK)
4. **输出格式**: 十六进制字符串

**签名示例：**

```
输入:
  AK = "your-access-key"
  SK = "your-secret-key"
  timestamp = 1234567890

待签名字符串:
  "ak=your-access-key&timestamp=1234567890"

签名结果 (示例):
  "a1b2c3d4e5f6..."
```

### 3.2 认证消息构造

在 `auth.ts:56-65` 构造认证消息：

```typescript
generateAuthMessage(): any {
  const credentials = this.generateAuthCredentials();
  return {
    type: "auth",                      // 消息类型
    ak: credentials.ak,                // Access Key
    agentId: this.agentId,             // Agent 标识
    timestamp: credentials.timestamp,  // 时间戳
    signature: credentials.signature,  // 签名
  };
}
```

### 3.3 认证流程

在 `websocket.ts:208-215` 发送认证：

```typescript
private authenticate(): void {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const authMessage = this.auth.generateAuthMessage();
  this.ws.send(JSON.stringify(authMessage));  // 发送 JSON 格式的认证消息
}
```

**认证时序图：**

```
Client                                    Server
  |                                         |
  |--- WebSocket 连接建立 ----------------->|
  |                                         |
  |--- 发送认证消息 ----------------------->|
  |    {                                    |
  |      "type": "auth",                    |
  |      "ak": "...",                       |
  |      "agentId": "...",                  |
  |      "timestamp": 1234567890,           |
  |      "signature": "..."                 |
  |    }                                    |
  |                                         |
  |                                         | (验证签名)
  |                                         |
  |<-- 认证响应 ----------------------------|
  |    {                                    |
  |      "type": "auth",                    |
  |      "data": {                          |
  |        "success": true                  |
  |      }                                  |
  |    }                                    |
  |                                         |
  | (启动心跳机制)                           |
  |                                         |
```

在 `websocket.ts:170-178` 处理认证响应：

```typescript
case "auth":
  if (message.data.success) {
    this.state.authenticated = true;
    this.startHeartbeat();  // 认证成功后才启动心跳
    this.emit("authenticated");
  } else {
    this.emit("authError", message.data.error);
  }
  break;
```

**认证状态管理：**

- 连接建立后立即发起认证 (`websocket.ts:55`)
- 认证成功后设置 `state.authenticated = true`
- 只有认证成功后才启动心跳机制
- 认证失败会触发 `authError` 事件

## 四、消息转换与发送

### 4.1 入站消息处理 (A2A → OpenClaw)

在 `channel.ts:254-273` 处理从小艺接收的消息：

```typescript
connection.on("message", async (message: A2ARequestMessage) => {
  // 将 A2A 协议消息转换为 OpenClaw 标准格式
  await ctx.handleInboundMessage({
    channel: "xiaoyi",                    // 渠道标识
    accountId: resolvedAccount.accountId, // 账号ID
    from: message.sender.id,              // 发送者ID
    text: message.content.text || "",     // 消息文本
    messageId: message.messageId,         // 消息ID
    timestamp: message.timestamp,         // 时间戳
    peer: {
      kind: "dm",                         // 对话类型: 私聊
      id: message.sender.id,              // 对话对象ID
    },
    // 保存原始 sessionId 用于回复
    meta: {
      sessionId: message.sessionId,
      conversationId: message.context?.conversationId,
    },
  });
});
```

**入站消息转换关键点：**

1. **渠道标识**: 设置 `channel: "xiaoyi"` 标识消息来源
2. **会话信息**: 保存 `sessionId` 到 `meta` 中，用于后续回复
3. **对话类型**: 设置 `peer.kind: "dm"` 表示私聊
4. **消息内容**: 提取 `content.text` 作为消息文本

### 4.2 出站消息处理 (OpenClaw → A2A)

在 `channel.ts:152-194` 实现文本消息发送：

```typescript
sendText: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
  // 1. 获取 WebSocket 连接
  const runtime = getXiaoYiRuntime();
  const connection = runtime.getConnection(ctx.accountId);

  // 2. 检查连接状态
  if (!connection || !connection.isReady()) {
    throw new Error(`XiaoYi account ${ctx.accountId} not connected`);
  }

  // 3. 获取 agentId
  const resolvedAccount = ctx.account as ResolvedXiaoYiAccount;
  const agentId = resolvedAccount.config.agentId;

  // 4. 构造 A2A 响应消息
  const response: A2AResponseMessage = {
    sessionId: ctx.to,  // 使用入站消息的 sessionId
    messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    agentId: agentId,
    sender: {
      id: agentId,
      name: "OpenClaw Agent",
      type: "agent",
    },
    content: {
      type: "text",
      text: ctx.text,  // OpenClaw 传入的文本内容
    },
    context: ctx.replyToId ? {
      replyToMessageId: ctx.replyToId,  // 如果是回复消息
    } : undefined,
    status: "success",
  };

  // 5. 通过 WebSocket 发送
  await connection.sendResponse(response);

  // 6. 返回发送结果
  return {
    channel: "xiaoyi",
    messageId: response.messageId,
    conversationId: ctx.to,
    timestamp: response.timestamp,
  };
}
```

在 `websocket.ts:89-103` 实际发送消息：

```typescript
async sendResponse(response: A2AResponseMessage): Promise<void> {
  // 1. 检查连接状态
  if (!this.isReady()) {
    throw new Error("WebSocket not ready");
  }

  // 2. 包装为 WebSocket 消息格式
  const message: A2AWebSocketMessage = {
    type: "message",
    data: {
      ...response,
      agentId: this.config.agentId,  // 确保包含 agentId
    },
  };

  // 3. 序列化并发送
  this.ws!.send(JSON.stringify(message));
}
```

**出站消息转换关键点：**

1. **连接检查**: 使用 `isReady()` 确保连接已建立且已认证
2. **消息ID生成**: 使用时间戳 + 随机字符串生成唯一ID
3. **SessionId传递**: 使用 `ctx.to` 作为 `sessionId`，确保消息路由正确
4. **状态标识**: 设置 `status: "success"` 表示消息发送成功

### 4.3 消息格式对照

#### A2A 请求消息 (从小艺接收)

```json
{
  "sessionId": "session-123",
  "messageId": "msg-456",
  "timestamp": 1234567890,
  "sender": {
    "id": "user-id",
    "name": "User Name",
    "type": "user"
  },
  "content": {
    "type": "text",
    "text": "你好"
  },
  "context": {
    "conversationId": "conv-789"
  }
}
```

#### OpenClaw 内部格式 (转换后)

```json
{
  "channel": "xiaoyi",
  "accountId": "default",
  "from": "user-id",
  "text": "你好",
  "messageId": "msg-456",
  "timestamp": 1234567890,
  "peer": {
    "kind": "dm",
    "id": "user-id"
  },
  "meta": {
    "sessionId": "session-123",
    "conversationId": "conv-789"
  }
}
```

#### A2A 响应消息 (发送给小艺)

```json
{
  "sessionId": "session-123",
  "messageId": "msg-789",
  "timestamp": 1234567891,
  "agentId": "your-agent-id",
  "sender": {
    "id": "your-agent-id",
    "name": "OpenClaw Agent",
    "type": "agent"
  },
  "content": {
    "type": "text",
    "text": "你好！有什么可以帮助你的？"
  },
  "context": {
    "replyToMessageId": "msg-456"
  },
  "status": "success"
}
```

### 4.4 媒体消息发送

在 `channel.ts:196-237` 实现媒体消息发送：

```typescript
sendMedia: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
  const runtime = getXiaoYiRuntime();
  const connection = runtime.getConnection(ctx.accountId);

  if (!connection || !connection.isReady()) {
    throw new Error(`XiaoYi account ${ctx.accountId} not connected`);
  }

  const resolvedAccount = ctx.account as ResolvedXiaoYiAccount;
  const agentId = resolvedAccount.config.agentId;

  // 构造 A2A 响应消息，包含媒体URL
  const response: A2AResponseMessage = {
    sessionId: ctx.to,
    messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    agentId: agentId,
    sender: {
      id: agentId,
      name: "OpenClaw Agent",
      type: "agent",
    },
    content: {
      type: "image",           // 媒体类型
      text: ctx.text,          // 可选的文本描述
      mediaUrl: ctx.mediaUrl,  // 媒体URL
    },
    context: ctx.replyToId ? {
      replyToMessageId: ctx.replyToId,
    } : undefined,
    status: "success",
  };

  await connection.sendResponse(response);

  return {
    channel: "xiaoyi",
    messageId: response.messageId,
    conversationId: ctx.to,
    timestamp: response.timestamp,
  };
}
```

**支持的媒体类型：**

- `text`: 文本消息
- `image`: 图片消息
- `audio`: 音频消息
- `video`: 视频消息
- `file`: 文件消息

## 五、接入 OpenClaw 消息处理体系

### 5.1 插件注册

在 `index.ts:34-42` 注册插件：

```typescript
register(api: OpenClawPluginApi) {
  // 1. 设置 runtime，用于管理 WebSocket 连接
  setXiaoYiRuntime(api.runtime);

  // 2. 注册 channel 插件
  api.registerChannel({ plugin: xiaoyiPlugin });

  console.log("XiaoYi channel plugin registered");
}
```

**插件注册流程：**

1. OpenClaw 启动时加载插件
2. 调用插件的 `register()` 方法
3. 插件通过 `api.registerChannel()` 注册 channel
4. OpenClaw 将 channel 加入消息路由系统

### 5.2 Channel Plugin 接口实现

`channel.ts` 实现了 OpenClaw 的 `ChannelPlugin` 接口，包含 5 个适配器：

#### 5.2.1 Config Adapter (配置管理)

```typescript
config: {
  // 列出所有账号ID
  listAccountIds: (cfg: any) => {
    const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;
    if (!channelConfig || !channelConfig.accounts) {
      return [];
    }
    return Object.keys(channelConfig.accounts);
  },

  // 解析账号配置
  resolveAccount: (cfg: any, accountId?: string) => {
    const resolvedAccountId = accountId || "default";
    const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;

    if (!channelConfig || !channelConfig.accounts) {
      return {
        accountId: resolvedAccountId,
        config: {
          enabled: false,
          wsUrl: "",
          ak: "",
          sk: "",
          agentId: "",
        },
        enabled: false,
      };
    }

    const accountConfig = channelConfig.accounts[resolvedAccountId];

    if (!accountConfig) {
      return {
        accountId: resolvedAccountId,
        config: {
          enabled: false,
          wsUrl: "",
          ak: "",
          sk: "",
          agentId: "",
        },
        enabled: false,
      };
    }

    return {
      accountId: resolvedAccountId,
      config: accountConfig,
      enabled: accountConfig.enabled !== false,
    };
  },

  // 默认账号ID
  defaultAccountId: (cfg: any) => {
    const channelConfig = cfg?.channels?.xiaoyi as XiaoYiChannelConfig;
    if (!channelConfig || !channelConfig.accounts) {
      return undefined;
    }
    const accountIds = Object.keys(channelConfig.accounts);
    return accountIds.includes("default") ? "default" : accountIds[0];
  },

  // 检查配置是否完整
  isConfigured: (account: any) => {
    if (!account || !account.config) {
      return false;
    }

    const config = account.config;
    const hasWsUrl = typeof config.wsUrl === 'string' && config.wsUrl.trim().length > 0;
    const hasAk = typeof config.ak === 'string' && config.ak.trim().length > 0;
    const hasSk = typeof config.sk === 'string' && config.sk.trim().length > 0;
    const hasAgentId = typeof config.agentId === 'string' && config.agentId.trim().length > 0;

    return hasWsUrl && hasAk && hasSk && hasAgentId;
  },

  // 描述账号信息
  describeAccount: (account: any) => ({
    accountId: account.accountId,
    name: account.config?.name || 'XiaoYi',
    enabled: account.enabled,
    configured: Boolean(
      account.config?.wsUrl &&
      account.config?.ak &&
      account.config?.sk &&
      account.config?.agentId
    ),
  }),
}
```

**配置文件示例 (openclaw.json):**

```json
{
  "channels": {
    "xiaoyi": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "wsUrl": "wss://hag.com/ws/link",
          "ak": "your-access-key",
          "sk": "your-secret-key",
          "agentId": "your-agent-id"
        }
      }
    }
  }
}
```

#### 5.2.2 Gateway Adapter (连接管理)

```typescript
gateway: {
  // 启动账号连接
  startAccount: async (ctx: ChannelGatewayStartAccountContext) => {
    const runtime = getXiaoYiRuntime();
    const resolvedAccount = ctx.account as ResolvedXiaoYiAccount;

    // 1. 启动 WebSocket 连接
    await runtime.startAccount(
      resolvedAccount.accountId,
      resolvedAccount.config
    );

    // 2. 设置消息处理器
    const connection = runtime.getConnection(resolvedAccount.accountId);
    if (connection) {
      connection.on("message", async (message: A2ARequestMessage) => {
        // 将 A2A 消息转换为 OpenClaw 格式并分发
        await ctx.handleInboundMessage({
          channel: "xiaoyi",
          accountId: resolvedAccount.accountId,
          from: message.sender.id,
          text: message.content.text || "",
          messageId: message.messageId,
          timestamp: message.timestamp,
          peer: {
            kind: "dm",
            id: message.sender.id,
          },
          meta: {
            sessionId: message.sessionId,
            conversationId: message.context?.conversationId,
          },
        });
      });
    }
  },

  // 停止账号连接
  stopAccount: async (ctx: ChannelGatewayStopAccountContext) => {
    const runtime = getXiaoYiRuntime();
    runtime.stopAccount(ctx.accountId);
  },

  // 探测账号状态
  probeAccount: async (ctx: ChannelGatewayProbeAccountContext) => {
    const runtime = getXiaoYiRuntime();
    const isConnected = runtime.isAccountConnected(ctx.accountId);

    return {
      status: isConnected ? "healthy" : "unhealthy",
      message: isConnected ? "Connected" : "Disconnected",
    };
  },
}
```

**Gateway 生命周期：**

```
OpenClaw 启动
    │
    ▼
gateway.startAccount()
    │
    ├─> runtime.startAccount()
    │   └─> WebSocket 连接建立
    │
    ├─> 设置消息监听器
    │   └─> connection.on("message", ...)
    │
    └─> 连接就绪
        │
        ▼
    接收消息 ──> ctx.handleInboundMessage()
        │           │
        │           └─> OpenClaw 消息路由
        │
        ▼
OpenClaw 关闭
    │
    ▼
gateway.stopAccount()
    │
    └─> runtime.stopAccount()
        └─> WebSocket 断开连接
```

#### 5.2.3 Outbound Adapter (消息发送)

```typescript
outbound: {
  deliveryMode: "direct",      // 直接发送模式
  textChunkLimit: 4000,        // 文本分块限制

  // 发送文本消息
  sendText: async (ctx: ChannelOutboundContext) => {
    // 前面已详细讲解 (4.2 节)
  },

  // 发送媒体消息
  sendMedia: async (ctx: ChannelOutboundContext) => {
    // 前面已详细讲解 (4.4 节)
  },
}
```

**Outbound 上下文 (ChannelOutboundContext):**

```typescript
{
  accountId: string;      // 账号ID
  to: string;             // 目标 (sessionId)
  text: string;           // 消息文本
  mediaUrl?: string;      // 媒体URL (可选)
  replyToId?: string;     // 回复的消息ID (可选)
  account: any;           // 账号配置
}
```

#### 5.2.4 Messaging Adapter (目标规范化)

```typescript
messaging: {
  normalizeTarget: async (ctx: ChannelMessagingNormalizeTargetContext) => {
    // 对于小艺，直接使用 sessionId 作为目标
    return ctx.to;
  },
}
```

**目标规范化说明：**

- 不同 channel 可能有不同的目标标识方式
- 小艺使用 `sessionId` 作为会话标识
- `normalizeTarget` 将 OpenClaw 的目标转换为 channel 特定格式

#### 5.2.5 Status Adapter (状态查询)

```typescript
status: {
  getAccountStatus: async (ctx: ChannelStatusGetAccountStatusContext) => {
    const runtime = getXiaoYiRuntime();
    const connection = runtime.getConnection(ctx.accountId);

    if (!connection) {
      return {
        status: "offline",
        message: "Not connected",
      };
    }

    const state = connection.getState();

    if (state.connected && state.authenticated) {
      return {
        status: "online",
        message: "Connected and authenticated",
      };
    } else if (state.connected) {
      return {
        status: "connecting",
        message: "Connected but not authenticated",
      };
    } else {
      return {
        status: "offline",
        message: `Reconnect attempts: ${state.reconnectAttempts}`,
      };
    }
  },
}
```

**状态类型：**

- `online`: 已连接且已认证
- `connecting`: 已连接但未认证
- `offline`: 未连接

### 5.3 Runtime 管理层

`runtime.ts` 提供了多账号管理能力：

```typescript
export class XiaoYiRuntime {
  private connections: Map<string, XiaoYiWebSocketManager> = new Map();
  private runtime: any = null;

  // 启动账号连接
  async startAccount(accountId: string, config: XiaoYiAccountConfig) {
    if (this.connections.has(accountId)) {
      console.log(`Account ${accountId} already connected`);
      return;  // 防止重复连接
    }

    const manager = new XiaoYiWebSocketManager(config);

    // 设置事件处理器
    manager.on("message", (message) => {
      this.handleIncomingMessage(accountId, message);
    });

    manager.on("error", (error) => {
      console.error(`XiaoYi account ${accountId} error:`, error);
    });

    manager.on("disconnected", () => {
      console.log(`XiaoYi account ${accountId} disconnected`);
    });

    manager.on("authenticated", () => {
      console.log(`XiaoYi account ${accountId} authenticated`);
    });

    manager.on("maxReconnectAttemptsReached", () => {
      console.error(`XiaoYi account ${accountId} max reconnect attempts reached`);
      this.stopAccount(accountId);  // 达到最大重连次数后停止
    });

    // 连接并保存
    await manager.connect();
    this.connections.set(accountId, manager);

    console.log(`XiaoYi account ${accountId} started`);
  }

  // 停止账号连接
  stopAccount(accountId: string): void {
    const manager = this.connections.get(accountId);
    if (manager) {
      manager.disconnect();
      this.connections.delete(accountId);
      console.log(`XiaoYi account ${accountId} stopped`);
    }
  }

  // 获取连接
  getConnection(accountId: string): XiaoYiWebSocketManager | undefined {
    return this.connections.get(accountId);
  }

  // 检查连接状态
  isAccountConnected(accountId: string): boolean {
    const manager = this.connections.get(accountId);
    return manager ? manager.isReady() : false;
  }

  // 处理入站消息
  private handleIncomingMessage(accountId: string, message: any): void {
    if (!this.runtime) {
      console.error("Runtime not set, cannot handle message");
      return;
    }

    // 通过事件分发给 OpenClaw
    this.runtime.emit("xiaoyi:message", {
      accountId,
      message,
    });
  }
}
```

**Runtime 职责：**

1. **多账号管理**: 使用 Map 管理多个 WebSocket 连接
2. **事件转发**: 将 WebSocket 事件转发给 OpenClaw
3. **生命周期管理**: 启动、停止、重连管理
4. **状态查询**: 提供连接状态查询接口

## 六、完整消息流程

### 6.1 接收消息流程

```
小艺服务器
    │
    │ WebSocket (A2A JSON)
    ▼
XiaoYiWebSocketManager.handleMessage()  [websocket.ts:162]
    │
    │ 解析 JSON
    │ 判断消息类型
    ▼
case "message":
    │
    │ emit("message", A2ARequestMessage)
    ▼
XiaoYiRuntime.handleIncomingMessage()  [runtime.ts:114]
    │
    │ runtime.emit("xiaoyi:message")
    ▼
Channel Gateway.startAccount()  [channel.ts:254]
    │
    │ connection.on("message", ...)
    │ 转换为 OpenClaw 格式
    ▼
ctx.handleInboundMessage({
  channel: "xiaoyi",
  accountId: "default",
  from: "user-id",
  text: "你好",
  ...
})
    │
    ▼
OpenClaw 核心框架
    │
    ├─> 会话管理 (Session Manager)
    │   └─> 根据 sessionId 查找或创建会话
    │
    ├─> Agent 路由 (Agent Router)
    │   └─> 根据配置路由到对应 Agent
    │
    └─> 消息处理 (Message Handler)
        └─> Agent 处理消息并生成响应
```

### 6.2 发送消息流程

```
OpenClaw 核心框架
    │
    │ Agent 生成响应
    ▼
消息路由系统
    │
    │ 根据 channel 查找 outbound adapter
    ▼
Channel Outbound.sendText()  [channel.ts:152]
    │
    ├─> 获取 WebSocket 连接
    │   runtime.getConnection(accountId)
    │
    ├─> 检查连接状态
    │   connection.isReady()
    │
    ├─> 构造 A2A 响应消息
    │   {
    │     sessionId: ctx.to,
    │     messageId: "msg_...",
    │     agentId: "...",
    │     content: { type: "text", text: "..." },
    │     status: "success"
    │   }
    │
    └─> 发送消息
        ▼
XiaoYiWebSocketManager.sendResponse()  [websocket.ts:89]
    │
    ├─> 检查连接状态
    │   isReady()
    │
    ├─> 包装为 WebSocket 消息
    │   { type: "message", data: {...} }
    │
    └─> 序列化并发送
        ws.send(JSON.stringify(message))
        │
        ▼
小艺服务器
```

### 6.3 完整交互时序图

```
用户      小艺服务器    XiaoYi Channel    OpenClaw 核心    Agent
 │            │              │                │             │
 │  发送消息   │              │                │             │
 │──────────>│              │                │             │
 │            │              │                │             │
 │            │ WebSocket    │                │             │
 │            │ A2A Message  │                │             │
 │            │────────────>│                │             │
 │            │              │                │             │
 │            │              │ handleInbound  │             │
 │            │              │ Message        │             │
 │            │              │──────────────>│             │
 │            │              │                │             │
 │            │              │                │ 路由消息     │
 │            │              │                │───────────>│
 │            │              │                │             │
 │            │              │                │             │ 处理消息
 │            │              │                │             │ 生成响应
 │            │              │                │             │
 │            │              │                │<────────────│
 │            │              │                │   响应      │
 │            │              │                │             │
 │            │              │<───────────────│             │
 │            │              │  sendText()    │             │
 │            │              │                │             │
 │            │              │ sendResponse() │             │
 │            │              │ (WebSocket)    │             │
 │            │<─────────────│                │             │
 │            │ A2A Response │                │             │
 │            │              │                │             │
 │<───────────│              │                │             │
 │  收到回复   │              │                │             │
```

### 6.4 错误处理流程

```
WebSocket 错误
    │
    ├─> 连接断开 (close event)
    │   │
    │   ├─> 清理定时器
    │   ├─> 更新状态
    │   └─> scheduleReconnect()
    │       │
    │       ├─> 检查重连次数
    │       ├─> 计算退避延迟
    │       └─> 延迟后重连
    │
    ├─> 心跳超时
    │   │
    │   ├─> disconnect()
    │   └─> scheduleReconnect()
    │
    ├─> 认证失败
    │   │
    │   └─> emit("authError")
    │
    └─> 消息解析错误
        │
        └─> emit("error")
```

## 七、关键设计亮点

### 7.1 分层架构

```
┌─────────────────────────────────────┐
│  OpenClaw 核心层                     │  ← 消息路由、会话管理
├─────────────────────────────────────┤
│  Channel 适配层 (channel.ts)        │  ← 协议适配、格式转换
├─────────────────────────────────────┤
│  Runtime 管理层 (runtime.ts)        │  ← 多账号管理、事件分发
├─────────────────────────────────────┤
│  WebSocket 层 (websocket.ts)        │  ← 连接管理、心跳、重连
├─────────────────────────────────────┤
│  认证层 (auth.ts)                    │  ← AK/SK 签名
└─────────────────────────────────────┘
```

**优势：**
- 职责清晰，易于维护
- 各层独立，便于测试
- 可扩展性强

### 7.2 健壮的连接管理

#### 指数退避重连

```typescript
delay = min(1000 * 2^n, 30000)
```

- 避免频繁重连导致服务器压力
- 逐步增加延迟，给服务器恢复时间
- 设置上限，防止无限等待

#### 双重心跳机制

1. **WebSocket ping/pong**: 原生机制，高效可靠
2. **超时检测**: 60 秒未收到 pong 则认为连接断开

#### 连接状态机

```
初始化 → 连接中 → 已连接 → 已认证 → 断开 → 重连中 → ...
```

- 清晰的状态转换
- 每个状态有明确的行为
- 防止状态混乱

### 7.3 标准化接口

完整实现 OpenClaw 的 `ChannelPlugin` 接口：

- **Config Adapter**: 配置管理
- **Gateway Adapter**: 连接生命周期
- **Outbound Adapter**: 消息发送
- **Messaging Adapter**: 目标规范化
- **Status Adapter**: 状态查询

**优势：**
- 无缝集成到 OpenClaw 框架
- 与其他 channel 保持一致的接口
- 便于框架统一管理

### 7.4 多账号支持

通过 Runtime 层管理多个 WebSocket 连接：

```typescript
private connections: Map<string, XiaoYiWebSocketManager> = new Map();
```

**特性：**
- 每个账号独立的 WebSocket 连接
- 独立的认证和心跳
- 独立的重连策略
- 统一的事件管理

### 7.5 事件驱动架构

使用 EventEmitter 实现松耦合：

```typescript
// WebSocket 层
manager.emit("message", message);
manager.emit("authenticated");
manager.emit("error", error);

// Runtime 层监听
manager.on("message", (message) => {
  this.handleIncomingMessage(accountId, message);
});
```

**优势：**
- 解耦各层之间的依赖
- 便于扩展和监控
- 易于调试和日志记录

### 7.6 安全认证

基于 HMAC-SHA256 的 AK/SK 签名机制：

```typescript
signature = HMAC-SHA256(SK, "ak={AK}&timestamp={TIMESTAMP}")
```

**安全特性：**
- 不传输明文密钥
- 时间戳防重放攻击
- 签名验证确保身份

### 7.7 消息格式转换

清晰的消息格式转换逻辑：

```
A2A 协议 ←→ OpenClaw 内部格式
```

**转换要点：**
- 保留原始 sessionId 用于回复
- 统一的消息结构
- 支持多种内容类型 (文本、图片、音频等)

### 7.8 错误处理

完善的错误处理机制：

- 连接超时保护
- 心跳超时检测
- 认证失败处理
- 消息解析错误处理
- 重连失败处理

### 7.9 可观测性

丰富的日志和状态查询：

```typescript
console.log(`XiaoYi account ${accountId} started`);
console.log(`Scheduling reconnect attempt ${this.state.reconnectAttempts}`);
console.error(`Max reconnection attempts reached`);
```

**状态查询接口：**
- `getState()`: 获取连接状态
- `isReady()`: 检查是否可发送消息
- `getAccountStatus()`: 获取账号状态

## 八、使用示例

### 8.1 配置文件

```json
{
  "channels": {
    "xiaoyi": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "wsUrl": "wss://hag.com/ws/link",
          "ak": "your-access-key",
          "sk": "your-secret-key",
          "agentId": "your-agent-id"
        }
      }
    }
  },
  "agents": {
    "bindings": [
      {
        "agentId": "main",
        "match": {
          "channel": "xiaoyi",
          "accountId": "default"
        }
      }
    ]
  }
}
```

### 8.2 多账号配置

```json
{
  "channels": {
    "xiaoyi": {
      "enabled": true,
      "accounts": {
        "account1": {
          "enabled": true,
          "wsUrl": "wss://hag.com/ws/link",
          "ak": "ak1",
          "sk": "sk1",
          "agentId": "agent1"
        },
        "account2": {
          "enabled": true,
          "wsUrl": "wss://hag.com/ws/link",
          "ak": "ak2",
          "sk": "sk2",
          "agentId": "agent2"
        }
      }
    }
  }
}
```

## 九、总结

openclaw-xiaoyi-channel 是一个设计良好的 OpenClaw 插件实现，展示了如何将外部协议 (A2A) 适配到 OpenClaw 框架中。

**核心特点：**

1. **分层架构**: 清晰的职责分离，易于维护和扩展
2. **健壮连接**: 指数退避重连 + 双重心跳机制
3. **标准接口**: 完整实现 ChannelPlugin 接口
4. **多账号支持**: 统一管理多个 WebSocket 连接
5. **事件驱动**: 松耦合的消息传递
6. **安全认证**: HMAC-SHA256 签名机制
7. **完善错误处理**: 多层次的错误处理和恢复

这个实现可以作为开发其他 OpenClaw channel 插件的参考范例。

