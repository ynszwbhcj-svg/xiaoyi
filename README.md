# @ynhcj/xiaoyichannel

XiaoYi channel plugin for OpenClaw with A2A protocol support.

## Features

- WebSocket-based connection to XiaoYi servers
- AK/SK authentication mechanism
- A2A (Agent-to-Agent) message protocol support
- Automatic reconnection with exponential backoff
- Heartbeat mechanism for connection health monitoring
- Full integration with OpenClaw's message routing and session management

## Installation

Install the plugin in your OpenClaw project:

```bash
openclaw plugins install @ynhcj/xiaoyichannel@1.0.0
```

## Configuration

After installation, add the XiaoYi channel configuration to your `openclaw.json` (or `.openclawd.json`):

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

### Configuration Parameters

- `wsUrl`: WebSocket server URL (e.g., `wss://hag.com/ws/link`)
- `ak`: Access Key for authentication
- `sk`: Secret Key for authentication
- `agentId`: Your agent identifier

### Multiple Accounts

You can configure multiple XiaoYi accounts:

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

## A2A Protocol

This plugin implements the A2A (Agent-to-Agent) message protocol as specified in the [Huawei Message Stream documentation](https://developer.huawei.com/consumer/cn/doc/service/message-stream-0000002505761434).

### Message Structure

**Incoming Request Message:**
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
    "text": "Hello, agent!"
  }
}
```

**Outgoing Response Message:**
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
    "text": "Hello! How can I help you?"
  },
  "status": "success"
}
```

## Authentication

The plugin uses AK/SK authentication as specified in the [Huawei Push Message documentation](https://developer.huawei.com/consumer/cn/doc/service/pushmessage-0000002505761436).

The authentication signature is generated using HMAC-SHA256:

```
signature = HMAC-SHA256(SK, "ak={AK}&timestamp={TIMESTAMP}")
```

## Connection Management

The plugin automatically manages WebSocket connections with the following features:

- **Automatic Reconnection**: Reconnects automatically on connection loss with exponential backoff
- **Heartbeat Monitoring**: Sends ping messages every 30 seconds to keep the connection alive
- **Connection Health**: Monitors connection status and reports health via OpenClaw's status system
- **Max Retry Limit**: Stops reconnection attempts after 10 failed attempts

## Session Management

The plugin integrates with OpenClaw's session management system:

- Sessions are scoped by `sessionId` from incoming A2A messages
- Each conversation maintains its own session context
- Session keys are automatically generated based on OpenClaw's configuration

## Usage

Once configured, the plugin will:

1. Automatically connect to the XiaoYi WebSocket server on startup
2. Authenticate using the provided AK/SK credentials
3. Receive incoming messages via WebSocket
4. Route messages to the appropriate OpenClaw agent
5. Send agent responses back through the WebSocket connection

## Troubleshooting

### Connection Issues

Check the OpenClaw logs for connection status:

```bash
openclaw logs
```

### Authentication Failures

Verify your AK/SK credentials are correct and have the necessary permissions.

### Message Delivery

Ensure your `agentId` is correctly configured and matches your XiaoYi account settings.

## Development

To build the plugin from source:

```bash
npm install
npm run build
```

## License

MIT

## Support

For issues and questions, please visit the [GitHub repository](https://github.com/ynhcj/xiaoyichannel).
