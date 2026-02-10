# OpenClaw XiaoYi Channel - 项目深度解析

> 版本: 2.5.3
> 作者: ynhcj
> 协议: MIT

---

## 目录

1. [项目概述](#项目概述)
2. [架构设计](#架构设计)
3. [核心模块详解](#核心模块详解)
4. [A2A 协议实现](#a2a-协议实现)
5. [消息处理流程](#消息处理流程)
6. [技术亮点](#技术亮点)
7. [配置指南](#配置指南)
8. [开发调试](#开发调试)
9. [参考资源](#参考资源)

---

## 项目概述

### 项目简介

**XiaoYi Channel Plugin for OpenClaw** 是一个为 OpenClaw AI Agent 框架开发的华为小艺 A2A (Agent-to-Agent) 协议适配插件。该插件通过 WebSocket 连接华为小艺服务，实现了双向消息通信、流式响应、上下文管理等功能。

### 核心特性

| 特性 | 描述 |
|------|------|
| **双服务器高可用** | 支持同时连接两个服务器，自动故障转移 |
| **AK/SK 认证** | 基于 HMAC-SHA256 的签名认证机制 |
| **流式响应** | 支持实时流式输出，提升用户体验 |
| **自动重连** | 指数退避算法，最多 50 次重试 |
| **心跳机制** | 协议级 (30s) + 应用级 (20s) 双重心跳 |
| **会话管理** | Session → Task 映射，支持取消和超时 |
| **多模态支持** | 文本、图片、文件等多种内容类型 |
| **直接指令处理** | clearContext/tasks/cancel 直接响应 |

### 技术栈

```
TypeScript 5.3.3     - 类型安全的开发语言
Node.js 20.x        - 运行时环境
ws 8.16.0           - WebSocket 客户端
zod 3.22.4          - 运行时类型验证
OpenClaw SDK        - 插件开发框架
```

---

## 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         OpenClaw Framework                           │
│                    (AI Agent Orchestration Layer)                   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                         ┌───────▼────────┐
                         │  Channel API   │
                         │  (Plugin SDK)  │
                         └───────┬────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────┐
│                         XiaoYi Channel Plugin                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │   Config     │  │   Gateway    │  │       Messaging          │   │
│  │   Adapter    │  │   Adapter    │  │       Adapter            │   │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │   Outbound   │  │    Status    │  │      Onboarding          │   │
│  │   Adapter    │  │   Adapter    │  │      Adapter             │   │
│  └───────┬──────┘  └──────┬───────┘  └──────────────────────────┘   │
└──────────┼──────────────────┼────────────────────────────────────────┘
           │                  │
    ┌──────▼──────┐    ┌──────▼──────┐
    │   Runtime   │    │  WebSocket  │
    │  Manager    │◄───┤   Manager   │
    └──────┬──────┘    └──────┬──────┘
           │                  │
    ┌──────▼──────┐    ┌──────▼──────┐
    │   Session   │    │     WS1     │ ◄─── wss://server1.com
    │   Mapping   │    │     WS2     │ ◄─── wss://server2.com
    └─────────────┘    └─────────────┘
                              │
                      ┌───────▼────────┐
                      │  XiaoYi Auth   │
                      │  (AK/SK HMAC)  │
                      └────────────────┘
```

### 目录结构

```
openclaw-xiaoyi-channel/
├── src/
│   ├── index.ts              # 插件入口点
│   ├── channel.ts            # Channel Plugin 实现 (核心)
│   ├── runtime.ts            # 运行时管理器
│   ├── websocket.ts          # WebSocket 连接管理
│   ├── auth.ts               # AK/SK 认证模块
│   ├── types.ts              # TypeScript 类型定义
│   ├── file-handler.ts       # 文件处理工具
│   ├── onboarding.ts         # 引导适配器
│   └── config-schema.ts      # 配置验证模式
├── dist/                     # 编译输出目录
├── package.json              # 项目配置
├── tsconfig.json             # TypeScript 配置
├── xiaoyi.js                 # CommonJS 入口点
├── openclaw.plugin.json      # OpenClaw 插件元数据
├── README.md                 # 项目说明
├── CLEAR_CONTEXT.md          # 上下文清理文档
└── claude.md                 # 本文档
```

---

## 核心模块详解

### 1. 插件入口 (index.ts)

**职责**: 插件注册、生命周期管理

```typescript
// src/index.ts:29-58
const plugin = {
  id: "xiaoyi",
  name: "XiaoYi Channel",
  description: "XiaoYi channel plugin with A2A protocol support",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 1. 设置运行时管理器
    setXiaoYiRuntime(api.runtime);

    // 2. 清理旧连接（防止热重载导致的重复连接）
    const runtime = getXiaoYiRuntime();
    if (runtime.isConnected()) {
      runtime.stop();
    }

    // 3. 注册 channel 插件
    api.registerChannel({ plugin: xiaoyiPlugin });
  },
};
```

**关键设计**:
- 使用全局变量存储 runtime 实例，支持热重载
- 实例 ID 追踪，便于调试

---

### 2. Channel Plugin (channel.ts)

**职责**: 实现 OpenClaw ChannelPlugin 接口，包含 6 个适配器

#### 2.1 Config Adapter - 配置管理

```typescript
// src/channel.ts:65-152
config: {
  // 单账号模式：固定返回 "default"
  listAccountIds: (cfg) => ["default"],

  resolveAccount: (cfg, accountId) => ({
    accountId: "default",
    config: cfg?.channels?.xiaoyi,
    enabled: cfg?.channels?.xiaoyi?.enabled !== false,
  }),

  // 配置完整性检查
  isConfigured: (account) => {
    const config = account.config;
    const hasAk = typeof config.ak === 'string' && config.ak.trim().length > 0;
    const hasSk = typeof config.sk === 'string' && config.sk.trim().length > 0;
    const hasAgentId = typeof config.agentId === 'string' && config.agentId.trim().length > 0;
    return hasAk && hasSk && hasAgentId;
  },
}
```

#### 2.2 Gateway Adapter - 连接管理

```typescript
// src/channel.ts:270-731
gateway: {
  startAccount: async (ctx) => {
    const runtime = getXiaoYiRuntime();

    // 1. 启动 WebSocket 连接
    await runtime.start(resolvedAccount.config);

    // 2. 获取连接并设置消息处理器
    const connection = runtime.getConnection();

    // 3. 注册消息处理事件
    connection.on("message", async (message: A2ARequestMessage) => {
      // 提取 sessionId（支持 params.sessionId 和顶层 sessionId）
      const sessionId = message.params?.sessionId || message.sessionId;

      // 存储 sessionId → taskId 映射
      runtime.setTaskIdForSession(sessionId, message.params.id);

      // 处理消息内容（文本、图片、文件）
      // ...

      // 调用 OpenClaw 消息分发器
      await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: msgContext,
        cfg: config,
        dispatcherOptions: {
          deliver: async (payload, info) => {
            // 流式响应处理
            if (info.kind === "block") {
              // 增量发送
              await conn.sendResponse(response, taskId, sessionId, false, true);
            } else if (info.kind === "final") {
              // 完整发送
              await conn.sendResponse(response, taskId, sessionId, true, false);
            }
          },
        },
      });
    });

    // 4. 注册取消处理事件
    connection.on("cancel", async (data) => {
      runtime.abortSession(data.sessionId);
      runtime.markSessionCompleted(data.sessionId);
    });
  },

  stopAccount: async (ctx) => {
    runtime.stop();
  },
}
```

#### 2.3 Outbound Adapter - 消息发送

```typescript
// src/channel.ts:157-265
outbound: {
  sendText: async (ctx) => {
    const connection = runtime.getConnection();
    const sessionId = ctx.to;
    const taskId = runtime.getTaskIdForSession(sessionId);

    const response: A2AResponseMessage = {
      sessionId,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      agentId: resolvedAccount.config.agentId,
      sender: { id: agentId, name: "OpenClaw Agent", type: "agent" },
      content: { type: "text", text: ctx.text },
      status: "success",
    };

    await connection.sendResponse(response, taskId, sessionId);
  },

  sendMedia: async (ctx) => {
    // 类似 sendText，但 content.type 为 "image"
  },
}
```

#### 2.4 Status Adapter - 健康检查

```typescript
// src/channel.ts:747-778
status: {
  getAccountStatus: async (ctx) => {
    const connection = runtime.getConnection();
    const state = connection.getState();

    if (state.connected && state.authenticated) {
      return { status: "online", message: "Connected and authenticated" };
    } else if (state.connected) {
      return { status: "connecting", message: "Connected but not authenticated" };
    } else {
      return {
        status: "offline",
        message: `Reconnect attempts: ${state.reconnectAttempts}/${state.maxReconnectAttempts}`
      };
    }
  },
}
```

---

### 3. Runtime Manager (runtime.ts)

**职责**: 运行时状态管理、会话超时控制、任务取消机制

#### 3.1 全局单例模式

```typescript
// src/runtime.ts:337-354
const GLOBAL_KEY = '__xiaoyi_runtime_instance__';

export function getXiaoYiRuntime(): XiaoYiRuntime {
  const g = global as any;
  if (!g[GLOBAL_KEY]) {
    console.log("XiaoYi: Creating NEW runtime instance (global storage)");
    g[GLOBAL_KEY] = new XiaoYiRuntime();
  } else {
    console.log(`XiaoYi: Reusing EXISTING runtime instance: ${g[GLOBAL_KEY].getInstanceId()}`);
  }
  return g[GLOBAL_KEY];
}
```

**设计要点**:
- 使用字符串 key 而非 Symbol，确保模块重载后一致性
- 每个实例有唯一 ID，便于调试追踪

#### 3.2 会话超时机制

```typescript
// src/runtime.ts:155-186
setTimeoutForSession(sessionId: string, callback: () => void): NodeJS.Timeout {
  // 清理现有超时和标志（支持会话复用）
  this.clearSessionTimeout(sessionId);
  this.sessionTimeoutSent.delete(sessionId);

  const timeoutId = setTimeout(() => {
    this.sessionTimeoutMap.delete(sessionId);
    this.sessionTimeoutSent.add(sessionId);
    callback();
  }, this.timeoutConfig.duration);

  this.sessionTimeoutMap.set(sessionId, timeoutId);
  return timeoutId;
}
```

**超时配置**:
```typescript
const DEFAULT_TIMEOUT_CONFIG = {
  enabled: true,
  duration: 60000,      // 60 秒
  message: "任务还在处理中，请稍后回来查看",
};
```

#### 3.3 任务取消机制

```typescript
// src/runtime.ts:278-304
createAbortControllerForSession(sessionId: string) {
  // 终止现有控制器
  this.abortSession(sessionId);

  const controller = new AbortController();
  this.sessionAbortControllerMap.set(sessionId, controller);
  return { controller, signal: controller.signal };
}

abortSession(sessionId: string): boolean {
  const controller = this.sessionAbortControllerMap.get(sessionId);
  if (controller) {
    controller.abort();
    this.sessionAbortControllerMap.delete(sessionId);
    return true;
  }
  return false;
}
```

---

### 4. WebSocket Manager (websocket.ts)

**职责**: 双服务器连接管理、消息路由、心跳保活

#### 4.1 双服务器架构

```typescript
// src/websocket.ts:25-80
export class XiaoYiWebSocketManager extends EventEmitter {
  // 双 WebSocket 连接
  private ws1: WebSocket | null = null;
  private ws2: WebSocket | null = null;

  // 双服务器状态
  private state1: ServerConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0
  };

  private state2: ServerConnectionState = {
    connected: false,
    ready: false,
    lastHeartbeat: 0,
    reconnectAttempts: 0
  };

  // Session → Server 映射（消息路由）
  private sessionServerMap = new Map<string, ServerId>();
}
```

#### 4.2 连接初始化

```typescript
// src/websocket.ts:194-250
private async connectToServer1(): Promise<void> {
  // 1. 生成认证头
  const authHeaders = this.auth.generateAuthHeaders();

  // 2. 检测 WSS + IP 格式，跳过证书验证
  const skipCertVerify = this.isWssWithIp(this.config.wsUrl1);

  // 3. 建立 WebSocket 连接
  this.ws1 = new WebSocket(this.config.wsUrl1, {
    headers: authHeaders,
    rejectUnauthorized: !skipCertVerify,
  });

  // 4. 设置事件处理器
  this.setupWebSocketHandlers(this.ws1, 'server1');

  // 5. 等待连接成功
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout")), 30000);
    this.ws1!.once("open", () => { clearTimeout(timeout); resolve(); });
    this.ws1!.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });

  // 6. 更新状态
  this.state1.connected = true;
  this.state1.ready = true;

  // 7. 发送初始化消息
  this.sendInitMessage(this.ws1, 'server1');

  // 8. 启动协议心跳
  this.startProtocolHeartbeat('server1');
}
```

#### 4.3 消息路由

```typescript
// src/websocket.ts:493-536
async sendResponse(
  response: A2AResponseMessage,
  taskId: string,
  sessionId: string,
  isFinal: boolean = true,
  append: boolean = false
): Promise<void> {
  // 1. 查找会话所属服务器
  const targetServer = this.sessionServerMap.get(sessionId);
  if (!targetServer) {
    throw new Error(`Cannot route response: unknown session ${sessionId}`);
  }

  // 2. 获取对应的 WebSocket 连接
  const ws = targetServer === 'server1' ? this.ws1 : this.ws2;
  const state = targetServer === 'server1' ? this.state1 : this.state2;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error(`${targetServer} is not available`);
  }

  // 3. 转换为 JSON-RPC 格式
  const jsonRpcResponse = this.convertToJsonRpcFormat(response, taskId, isFinal, append);

  // 4. 发送消息
  const message: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: this.config.agentId,
    sessionId: sessionId,
    taskId: taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  ws.send(JSON.stringify(message));
}
```

#### 4.4 心跳机制

**协议级心跳** (30秒间隔):
```typescript
// src/websocket.ts:893-915
private startProtocolHeartbeat(serverId: ServerId): void {
  const interval = setInterval(() => {
    const ws = serverId === 'server1' ? this.ws1 : this.ws2;
    const state = serverId === 'server1' ? this.state1 : this.state2;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();  // WebSocket 协议级 ping

      // 检测超时（90秒无响应）
      const now = Date.now();
      if (state.lastHeartbeat > 0 && now - state.lastHeartbeat > 90000) {
        console.warn(`[${serverId}] Heartbeat timeout, reconnecting...`);
        ws.close();
      }
    }
  }, 30000);
}
```

**应用级心跳** (20秒间隔):
```typescript
// src/websocket.ts:936-960
private startAppHeartbeat(): void {
  this.appHeartbeatInterval = setInterval(() => {
    const heartbeatMessage: OutboundWebSocketMessage = {
      msgType: "heartbeat",
      agentId: this.config.agentId,
    };

    // 向所有连接的服务器发送
    [this.ws1, this.ws2].forEach(ws => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(heartbeatMessage));
      }
    });
  }, 20000);
}
```

#### 4.5 自动重连

```typescript
// src/websocket.ts:964-998
private scheduleReconnect(serverId: ServerId): void {
  const state = serverId === 'server1' ? this.state1 : this.state2;

  // 最大重试次数检查
  if (state.reconnectAttempts >= 50) {
    this.emit("maxReconnectAttemptsReached", serverId);
    return;
  }

  // 指数退避算法
  const delay = Math.min(2000 * Math.pow(2, state.reconnectAttempts), 60000);
  state.reconnectAttempts++;

  const timeout = setTimeout(async () => {
    try {
      if (serverId === 'server1') {
        await this.connectToServer1();
      } else {
        await this.connectToServer2();
      }
    } catch (error) {
      this.scheduleReconnect(serverId);
    }
  }, delay);
}
```

**退避策略**:
```
尝试 1: 2秒
尝试 2: 4秒
尝试 3: 8秒
尝试 4: 16秒
尝试 5: 32秒
尝试 6+: 60秒（上限）
```

#### 4.6 连接稳定性检查

```typescript
// src/websocket.ts:1037-1052
private scheduleStableConnectionCheck(serverId: ServerId): void {
  const timer = setTimeout(() => {
    const state = serverId === 'server1' ? this.state1 : this.state2;
    if (state.connected) {
      // 连接稳定 10 秒后重置重连计数器
      console.log(`[${serverId}] Connection stable, resetting reconnect counter`);
      state.reconnectAttempts = 0;
    }
  }, 10000);  // 10秒稳定阈值
}
```

---

### 5. Authentication Module (auth.ts)

**职责**: AK/SK 签名生成、认证凭证管理

#### 5.1 HMAC-SHA256 签名算法

```typescript
// src/auth.ts:42-50
private generateSignature(timestamp: string): string {
  // HMAC-SHA256(SK, timestamp)
  const hmac = crypto.createHmac("sha256", this.sk);
  hmac.update(timestamp);
  const digest = hmac.digest();

  // Base64 编码
  return digest.toString("base64");
}
```

#### 5.2 认证头生成

```typescript
// src/auth.ts:63-73
generateAuthHeaders(): Record<string, string> {
  const timestamp = Date.now();
  const signature = this.generateSignature(timestamp.toString());

  return {
    "x-access-key": this.ak,
    "x-sign": signature,
    "x-ts": timestamp.toString(),
    "x-agent-id": this.agentId,
  };
}
```

**签名验证流程**:
```
1. 客户端生成 timestamp
2. 计算 signature = Base64(HMAC-SHA256(SK, timestamp))
3. 发送认证头: { x-access-key: AK, x-sign: signature, x-ts: timestamp }
4. 服务器使用相同算法验证签名
```

---

### 6. File Handler (file-handler.ts)

**职责**: 文件下载、MIME 类型检测、内容提取

#### 6.1 图片处理

```typescript
// src/file-handler.ts:76-103
export async function extractImageFromUrl(
  url: string,
  limits?: Partial<ImageLimits>
): Promise<InputImageContent> {
  const { buffer, mimeType } = await fetchFromUrl(url, maxBytes, timeoutMs);

  if (!allowedMimes.has(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }

  return {
    type: "image",
    data: buffer.toString("base64"),  // Base64 编码
    mimeType,
  };
}
```

**支持的图片类型**:
- JPEG (`image/jpeg`)
- PNG (`image/png`)
- GIF (`image/gif`)
- WebP (`image/webp`)

#### 6.2 文本文件处理

```typescript
// src/file-handler.ts:108-124
export async function extractTextFromUrl(
  url: string,
  maxBytes: number = 5_000_000,
  timeoutMs: number = 30_000
): Promise<string> {
  const { buffer, mimeType } = await fetchFromUrl(url, maxBytes, timeoutMs);

  const textMimes = [
    "text/plain", "text/markdown", "text/html",
    "text/csv", "application/json", "application/xml"
  ];

  if (!textMimes.some(tm => mimeType.startsWith(tm) || mimeType === tm)) {
    throw new Error(`Unsupported text type: ${mimeType}`);
  }

  return buffer.toString("utf-8");
}
```

---

## A2A 协议实现

### 协议概述

A2A (Agent-to-Agent) 协议是华为小艺定义的 Agent 间通信协议，基于 JSON-RPC 2.0 规范。

### 请求消息格式

```json
{
  "agentId": "your-agent-id",
  "jsonrpc": "2.0",
  "id": "msg_1234567890",
  "method": "message/stream",
  "sessionId": "session_abc",
  "params": {
    "id": "task_xyz",
    "sessionId": "session_abc",
    "message": {
      "role": "user",
      "parts": [
        { "kind": "text", "text": "你好，请介绍一下自己" },
        {
          "kind": "file",
          "file": {
            "name": "image.jpg",
            "mimeType": "image/jpeg",
            "uri": "https://example.com/image.jpg"
          }
        }
      ]
    }
  }
}
```

### 响应消息格式

#### 标准响应包装

```json
{
  "msgType": "agent_response",
  "agentId": "your-agent-id",
  "sessionId": "session_abc",
  "taskId": "task_xyz",
  "msgDetail": "{...JSON-RPC 2.0 response...}"
}
```

#### Artifact Update (内容响应)

```json
{
  "jsonrpc": "2.0",
  "id": "msg_response",
  "result": {
    "taskId": "task_xyz",
    "kind": "artifact-update",
    "append": true,
    "lastChunk": false,
    "final": false,
    "artifact": {
      "artifactId": "artifact_123",
      "parts": [
        { "kind": "text", "text": "你好！我是AI助手..." }
      ]
    }
  }
}
```

#### Status Update (状态更新)

```json
{
  "jsonrpc": "2.0",
  "id": "status_123",
  "result": {
    "taskId": "task_xyz",
    "kind": "status-update",
    "final": false,
    "status": {
      "message": {
        "role": "agent",
        "parts": [
          { "kind": "text", "text": "任务还在处理中，请稍后回来查看" }
        ]
      },
      "state": "working"
    }
  }
}
```

### 特殊指令

#### Clear Context (清理上下文)

**请求**:
```json
{
  "jsonrpc": "2.0",
  "id": "msg_clear",
  "sessionId": "session_abc",
  "method": "clearContext"
}
```

**响应**:
```json
{
  "jsonrpc": "2.0",
  "id": "msg_clear",
  "result": {
    "status": {
      "state": "cleared"
    }
  }
}
```

#### Tasks Cancel (取消任务)

**请求**:
```json
{
  "jsonrpc": "2.0",
  "id": "msg_cancel",
  "method": "tasks/cancel",
  "sessionId": "session_abc",
  "taskId": "task_xyz"
}
```

**响应**:
```json
{
  "jsonrpc": "2.0",
  "id": "msg_cancel",
  "result": {
    "id": "msg_cancel",
    "status": {
      "state": "canceled"
    }
  }
}
```

---

## 消息处理流程

### 完整消息处理链路

```
┌─────────────────┐
│ XiaoYi Server   │
│  (WebSocket)    │
└────────┬────────┘
         │
         │ 1. 接收 A2A 请求
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   WebSocket Manager                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ handleIncomingMessage()                                   │  │
│  │  - 验证 agentId                                           │  │
│  │  - 提取 sessionId                                         │  │
│  │  - 记录 session → server 映射                             │  │
│  │  - 发送 "message" 事件                                    │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │ 2. 触发消息事件
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Channel Gateway                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ connection.on("message", ...)                             │  │
│  │  - 存储 sessionId → taskId                                │  │
│  │  - 解析消息内容 (文本/图片/文件)                           │  │
│  │  - 构建 MsgContext                                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │ 3. 分发到 OpenClaw
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   OpenClaw Runtime                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ dispatchReplyWithBufferedBlockDispatcher()               │  │
│  │  - 调用 AI Agent                                          │  │
│  │  - 流式返回响应                                           │  │
│  │  - deliver() 回调                                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │ 4. 处理响应
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Dispatcher Callback                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ deliver(payload, info)                                    │  │
│  │  - kind === "block": 增量发送 (append=true)              │  │
│  │  - kind === "final": 完整发送 (isFinal=true)              │  │
│  │  - 检查超时状态                                           │  │
│  │  - 检查取消状态                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │ 5. 发送响应
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   WebSocket Manager                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ sendResponse()                                            │  │
│  │  - 查找目标服务器 (session → server)                      │  │
│  │  - 转换为 JSON-RPC 格式                                   │  │
│  │  - 发送 agent_response                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │ 6. 返回小艺服务器
                               ▼
┌─────────────────┐
│ XiaoYi Server   │
│  (WebSocket)    │
└─────────────────┘
```

### 流式响应处理

```
AI Agent 输出流
     │
     ▼
┌─────────────────┐
│  block event    │ → 增量文本 (append=true, final=false)
│  block event    │ → 增量文本 (append=true, final=false)
│  block event    │ → 增量文本 (append=true, final=false)
│  final event    │ → 完整文本 (append=false, final=true)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   onIdle()      │ → 发送 isFinal=true 关闭流
└─────────────────┘
```

### 超时保护机制

```
请求开始
    │
    ▼
┌──────────────────┐
│  启动 60s 定时器  │
└────────┬─────────┘
         │
         ├─────────────────┐
         │                 │
         ▼                 ▼
   ┌─────────┐       ┌──────────┐
   │ 响应到达 │       │ 60s 超时  │
   └────┬────┘       └─────┬────┘
        │                 │
        ▼                 ▼
  清除定时器        发送状态更新
  发送响应         (state: working)
  标记完成         不标记完成
```

---

## 技术亮点

### 1. 双服务器高可用

**问题**: 单点故障导致服务不可用

**解决方案**:
- 同时连接两个服务器
- Session → Server 映射，确保消息路由正确
- 任一服务器故障时自动切换

```typescript
// 会话到服务器的映射
private sessionServerMap = new Map<string, ServerId>();

// 消息自动路由
const targetServer = this.sessionServerMap.get(sessionId);
const ws = targetServer === 'server1' ? this.ws1 : this.ws2;
```

### 2. 智能重连策略

**指数退避 + 连接稳定性检查**:

```typescript
// 重连延迟: 2s, 4s, 8s, 16s, 32s, 60s (上限)
const delay = Math.min(2000 * Math.pow(2, attempts), 60000);

// 连接稳定 10s 后重置计数器
setTimeout(() => {
  if (connected) reconnectAttempts = 0;
}, 10000);
```

### 3. 流式响应优化

**增量发送**:
```
用户: "写一首诗"

AI: "春风又绿江南岸"    → block 事件，发送增量
    "明月何时照我还"    → block 事件，发送增量
    "春风又绿江南岸，明月何时照我还" → final 事件，发送完整
```

**防止重复 Final**:
```typescript
if (hasSentFinal) {
  console.log("Skipping duplicate final response");
  return;
}
hasSentFinal = true;
```

### 4. 证书验证优化

**WSS + IP 自动跳过验证**:

```typescript
private isWssWithIp(urlString: string): boolean {
  const url = new URL(urlString);
  if (url.protocol !== 'wss:') return false;

  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  return ipv4Regex.test(url.hostname);
}

// 使用
new WebSocket(url, {
  rejectUnauthorized: !this.isWssWithIp(url)
});
```

### 5. 全局单例热重载

```typescript
// 使用字符串 key 确保模块重载后一致性
const GLOBAL_KEY = '__xiaoyi_runtime_instance__';

export function getXiaoYiRuntime() {
  if (!global[GLOBAL_KEY]) {
    global[GLOBAL_KEY] = new XiaoYiRuntime();
  }
  return global[GLOBAL_KEY];
}
```

### 6. 类型安全设计

```typescript
// 类型守卫
private isA2ARequestMessage(data: any): data is A2ARequestMessage {
  return data &&
    typeof data.agentId === "string" &&
    data.jsonrpc === "2.0" &&
    data.method === "message/stream" &&
    // ... 完整验证
}

// 使用
if (this.isA2ARequestMessage(message)) {
  // TypeScript 知道这是 A2ARequestMessage 类型
}
```

---

## 配置指南

### 基础配置

```json
{
  "channels": {
    "xiaoyi": {
      "enabled": true,
      "wsUrl1": "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
      "wsUrl2": "wss://116.63.174.231/openclaw/v1/ws/link",
      "ak": "your-access-key",
      "sk": "your-secret-key",
      "agentId": "your-agent-id",
      "enableStreaming": true
    }
  }
}
```

### 向后兼容配置

```json
{
  "channels": {
    "xiaoyi": {
      "enabled": true,
      "wsUrl": "wss://custom-server.com/ws",  // 兼容旧格式
      "ak": "your-access-key",
      "sk": "your-secret-key",
      "agentId": "your-agent-id"
    }
  }
}
```

**说明**: `wsUrl` 会被映射到 `wsUrl1`，`wsUrl2` 使用默认值

### 超时配置

```typescript
// 在运行时修改超时配置
runtime.setTimeoutConfig({
  enabled: true,
  duration: 120000,  // 120 秒
  message: "AI 正在思考中，请稍候...",
});
```

### 环境变量配置

```bash
# .env
XIAOYI_AK=your-access-key
XIAOYI_SK=your-secret-key
XIAOYI_AGENT_ID=your-agent-id
XIAOYI_WS_URL1=wss://server1.com/ws
XIAOYI_WS_URL2=wss://server2.com/ws
```

---

## 开发调试

### 构建项目

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 输出目录: dist/
```

### 调试日志

**关键日志标记**:
```
[WS Manager]   - WebSocket 连接管理
[Server1/2]    - 服务器特定事件
[MAP]          - 会话映射
[ROUTE]        - 消息路由
[STREAM]       - 流式响应
[TIMEOUT]      - 超时处理
[ABORT]        - 任务取消
[CLEAR]        - 上下文清理
[STATUS]       - 状态更新
[DELIVER]      - 消息分发
```

### 常见问题

#### 1. 连接失败

**检查项**:
- AK/SK 是否正确
- agentId 是否匹配
- 网络是否可达
- 证书验证问题

**解决方法**:
```typescript
// 跳过证书验证 (仅用于 IP 地址)
const skipCertVerify = this.isWssWithIp(url);
new WebSocket(url, { rejectUnauthorized: !skipCertVerify });
```

#### 2. 消息未发送

**检查项**:
- sessionId → taskId 映射是否存在
- 目标服务器是否连接
- 消息格式是否正确

#### 3. 流式响应卡住

**检查项**:
- 是否发送 `isFinal=true`
- onIdle 回调是否执行

---

## 参考资源

### 官方文档

- [华为消息流文档](https://developer.huawei.com/consumer/cn/doc/service/message-stream-0000002505761434)
- [华为推送消息认证](https://developer.huawei.com/consumer/cn/doc/service/pushmessage-0000002505761436)
- [清理上下文协议](https://developer.huawei.com/consumer/cn/doc/service/clear-context-0000002537681163)
- [任务取消协议](https://developer.huawei.com/consumer/cn/doc/service/tasks-cancel-0000002537561193)

### OpenClaw 相关

- [OpenClaw GitHub](https://github.com/anthropics/openclaw)
- [OpenClaw Plugin SDK](https://github.com/anthropics/openclaw/tree/main/packages/plugin-sdk)

### 依赖库

- [ws - WebSocket Client](https://github.com/websockets/ws)
- [zod - Type Validation](https://zod.dev/)
- [TypeScript](https://www.typescriptlang.org/)

---

## 附录

### 类型定义速查

```typescript
// 会话配置
interface XiaoYiChannelConfig {
  enabled: boolean;
  wsUrl1?: string;
  wsUrl2?: string;
  ak: string;
  sk: string;
  agentId: string;
  enableStreaming?: boolean;
}

// A2A 请求
interface A2ARequestMessage {
  agentId: string;
  jsonrpc: "2.0";
  id: string;
  method: "message/stream";
  sessionId?: string;
  params: {
    id: string;
    sessionId?: string;
    message: {
      role: "user" | "agent";
      parts: Array<{ kind: "text" | "file" | "data" }>;
    };
  };
}

// A2A 响应
interface A2AResponseMessage {
  sessionId: string;
  messageId: string;
  timestamp: number;
  agentId: string;
  content: {
    type: "text" | "image" | "file";
    text?: string;
    mediaUrl?: string;
  };
  status: "success" | "error";
}
```

### 状态码说明

| 状态 | 说明 |
|------|------|
| `online` | 已连接并认证成功 |
| `connecting` | 已连接但未认证 |
| `offline` | 未连接，正在重连 |
| `cleared` | 上下文已清除 |
| `canceled` | 任务已取消 |
| `working` | 任务处理中 |
| `completed` | 任务已完成 |

### 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.5.3 | 2025-02 | 流式响应优化、超时保护增强 |
| 2.0.x | 2025-01 | 双服务器支持、消息路由 |
| 1.0.x | 2024-12 | 初始版本 |

---

**文档生成时间**: 2025-02-10
**项目版本**: 2.5.3
**维护者**: ynhcj
