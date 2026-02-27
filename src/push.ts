import * as crypto from "crypto";
import { XiaoYiChannelConfig } from "./types";

/**
 * Push message sending service
 * Sends notifications to XiaoYi clients via webhook API
 */
export class XiaoYiPushService {
  private config: XiaoYiChannelConfig;
  private readonly pushUrl = "https://hag.cloud.huawei.com/open-ability-agent/v1/agent-webhook";

  constructor(config: XiaoYiChannelConfig) {
    this.config = config;
  }

  /**
   * Check if push functionality is configured
   */
  isConfigured(): boolean {
    return Boolean(
      this.config.apiId?.trim() &&
      this.config.pushId?.trim() &&
      this.config.ak?.trim() &&
      this.config.sk?.trim()
    );
  }

  /**
   * Generate HMAC-SHA256 signature
   */
  private generateSignature(timestamp: string): string {
    const hmac = crypto.createHmac("sha256", this.config.sk);
    hmac.update(timestamp);
    return hmac.digest().toString("base64");
  }

  /**
   * Generate UUID
   */
  private generateUUID(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Send push notification (with summary text)
   * @param text - Summary text to send (e.g., first 30 characters)
   * @param pushText - Push notification message (e.g., "任务已完成：xxx...")
   */
  async sendPush(text: string, pushText: string): Promise<boolean> {
    if (!this.isConfigured()) {
      console.log("[PUSH] Push not configured, skipping");
      return false;
    }

    try {
      const timestamp = Date.now().toString();
      const signature = this.generateSignature(timestamp);
      const messageId = this.generateUUID();

      const payload = {
        jsonrpc: "2.0",
        id: messageId,
        result: {
          id: this.generateUUID(),
          apiId: this.config.apiId,
          pushId: this.config.pushId,
          pushText: pushText,
          kind: "task",
          artifacts: [{
            artifactId: this.generateUUID(),
            parts: [{
              kind: "text",
              text: text,  // Summary text
            }]
          }],
          status: { state: "completed" }
        }
      };

      console.log(`[PUSH] Sending push notification: ${pushText}`);

      const response = await fetch(this.pushUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "x-hag-trace-id": this.generateUUID(),
          "X-Access-Key": this.config.ak,
          "X-Sign": signature,
          "X-Ts": timestamp,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log("[PUSH] Push notification sent successfully");
        return true;
      } else {
        console.error(`[PUSH] Failed: HTTP ${response.status}`);
        return false;
      }
    } catch (error) {
      console.error("[PUSH] Error:", error);
      return false;
    }
  }
}
