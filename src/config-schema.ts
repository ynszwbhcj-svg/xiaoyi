import { z } from 'zod';

/**
 * XiaoYi configuration schema using Zod
 * Defines the structure for XiaoYi A2A protocol configuration
 */
export const XiaoYiConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional().default(true),

  /** WebSocket URL for A2A connection */
  wsUrl: z.string().optional(),

  /** Access Key for authentication */
  ak: z.string().optional(),

  /** Secret Key for authentication */
  sk: z.string().optional(),

  /** Agent ID for this XiaoYi agent */
  agentId: z.string().optional(),

  /** Enable debug logging */
  debug: z.boolean().optional().default(false),

  /** Enable streaming responses (default: false) */
  enableStreaming: z.boolean().optional().default(false),

  /** Multi-account configuration */
  accounts: z.record(z.string(), z.unknown()).optional(),
});

export type XiaoYiConfig = z.infer<typeof XiaoYiConfigSchema>;
