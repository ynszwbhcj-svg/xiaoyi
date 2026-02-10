# 小艺 clearContext 指令处理

## 概述

根据 [华为文档](https://developer.huawei.com/consumer/cn/doc/service/clear-context-0000002537681163)，当接收到 `clearContext` 指令时，channel 应直接返回成功响应，不需要经过 OpenClaw 的消息处理流程。

## 请求格式

```json
{
  "jsonrpc": "2.0",
  "id": "全局唯一消息序列号",
  "sessionId": "会话唯一标识符",
  "method": "clearContext"
}
```

## 响应格式（使用标准消息包装）

clearContext 响应使用与其他消息相同的包装格式：

```json
{
  "msgType": "agent_response",
  "agentId": "your-agent-id",
  "sessionId": "session_abc",
  "taskId": "msg_1234567890",
  "msgDetail": "{\"jsonrpc\":\"2.0\",\"id\":\"msg_1234567890\",\"result\":{\"status\":{\"state\":\"cleared\"}}}"
}
```

### msgDetail 内部结构

msgDetail 字段包含标准的 JSON-RPC 2.0 clearContext 响应：

```json
{
  "jsonrpc": "2.0",
  "id": "msg_1234567890",
  "result": {
    "status": {
      "state": "cleared"
    }
  }
}
```

## 实现说明

### 关键代码

**src/websocket.ts:371-385**

```typescript
// Handle JSON-RPC 2.0 clearContext method (直接响应，不走 OpenClaw)
if (message.method === "clearContext") {
  console.log(`[CLEAR] Received clearContext for session: ${message.sessionId}`);
  // 直接返回成功响应
  this.sendClearContextResponse(message.id, message.sessionId, true).catch(error => {
    console.error("Failed to send clearContext response:", error);
  });
  // 可选：通知应用清除会话上下文
  this.emit("clear", {
    sessionId: message.sessionId,
    id: message.id,
  });
  return;
}
```

**src/websocket.ts:157-189 - sendClearContextResponse 方法**

```typescript
async sendClearContextResponse(requestId: string, sessionId: string, success: boolean = true): Promise<void> {
  if (!this.isReady()) {
    throw new Error("WebSocket not ready");
  }

  const jsonRpcResponse: A2AJsonRpcResponse = {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      status: {
        state: success ? "cleared" : "failed"
      }
    } as A2AClearContextResult,
  };

  const message: OutboundWebSocketMessage = {
    msgType: "agent_response",      // ← 标准消息类型
    agentId: this.config.agentId,    // ← Agent ID
    sessionId: sessionId,             // ← 会话 ID
    taskId: requestId,                // ← 任务 ID (使用请求的 id)
    msgDetail: JSON.stringify(jsonRpcResponse),  // ← JSON-RPC 响应
  };

  console.log("\n[CLEAR] Sending clearContext response:");
  console.log(`  msgType: ${message.msgType}`);
  console.log(`  agentId: ${message.agentId}`);
  console.log(`  sessionId: ${message.sessionId}`);
  console.log(`  taskId: ${message.taskId}`);
  console.log(`  msgDetail: ${message.msgDetail}`);
  console.log("")

  this.sendMessage(message);
}
```

### 处理流程

```
接收 clearContext 请求 (JSON-RPC 2.0)
  ↓
检测 method === "clearContext"
  ↓
构建标准消息包装:
  - msgType: "agent_response"
  - agentId: "your-agent-id"
  - sessionId: "session_abc"
  - taskId: "msg_1234567890"
  - msgDetail: "{...JSON-RPC 2.0 response...}"
  ↓
发送响应 (不走 OpenClaw)
  ↓
发送 clear 事件 (可选，通知应用)
  ↓
结束
```

### 与普通消息的对比

| 特性 | clearContext | 普通消息 (artifact-update) |
|------|-------------|--------------------------|
| **处理位置** | WebSocket 层 | Channel 层 |
| **OpenClaw** | 不经过 | 经过 |
| **响应时间** | 立即 (<10ms) | 取决于处理时间 |
| **msgType** | `agent_response` | `agent_response` |
| **msgDetail** | clearContext JSON-RPC | artifact-update JSON-RPC |

### 消息格式对比

**clearContext 响应的 msgDetail:**
```json
{
  "jsonrpc": "2.0",
  "id": "msg_123",
  "result": {
    "status": {
      "state": "cleared"
    }
  }
}
```

**普通消息响应的 msgDetail:**
```json
{
  "jsonrpc": "2.0",
  "id": "msg_456",
  "result": {
    "taskId": "task_456",
    "kind": "artifact-update",
    "append": false,
    "lastChunk": true,
    "final": true,
    "artifact": {
      "artifactId": "artifact_789",
      "parts": [...]
    }
  }
}
```

## 测试示例

### 发送 clearContext 请求

```json
{
  "jsonrpc": "2.0",
  "id": "msg_1234567890",
  "sessionId": "session_abc",
  "method": "clearContext"
}
```

### 预期响应（完整）

```json
{
  "msgType": "agent_response",
  "agentId": "your-agent-id",
  "sessionId": "session_abc",
  "taskId": "msg_1234567890",
  "msgDetail": "{\"jsonrpc\":\"2.0\",\"id\":\"msg_1234567890\",\"result\":{\"status\":{\"state\":\"cleared\"}}}"
}
```

### 日志输出

```
[CLEAR] Received clearContext for session: session_abc

[CLEAR] Sending clearContext response:
  msgType: agent_response
  agentId: your-agent-id
  sessionId: session_abc
  taskId: msg_1234567890
  msgDetail: {"jsonrpc":"2.0","id":"msg_1234567890","result":{"status":{"state":"cleared"}}}
```

## 兼容性

同时支持旧格式的 `action: "clear"` 消息，保持向后兼容。

## 状态值说明

| 状态值 | 说明 |
|--------|------|
| `cleared` | 上下文已成功清除 |
| `failed` | 清除失败 |
| `unknown` | 未知状态 |

当前实现固定返回 `cleared`，表示总是成功。
