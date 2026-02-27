import { z } from 'zod';

/**
 * XiaoYi configuration schema using Zod
 * Defines the structure for XiaoYi A2A protocol configuration
 */
export const XiaoYiConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional().default(false),

  /** First WebSocket server URL */
  wsUrl1: z.string().optional().default("wss://hag.cloud.huawei.com/openclaw/v1/ws/link"),

  /** Second WebSocket server URL */
  wsUrl2: z.string().optional().default("wss://116.63.174.231/openclaw/v1/ws/link"),

  /** Access Key for authentication */
  ak: z.string().optional(),

  /** Secret Key for authentication */
  sk: z.string().optional(),

  /** Agent ID for this XiaoYi agent */
  agentId: z.string().optional(),

  /** Enable debug logging */
  debug: z.boolean().optional().default(false),

  /** Multi-account configuration */
  accounts: z.record(z.string(), z.unknown()).optional(),
});

export type XiaoYiConfig = z.infer<typeof XiaoYiConfigSchema>;
