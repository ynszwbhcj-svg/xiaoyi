import * as crypto from "crypto";
import { AuthCredentials } from "./types";

/**
 * Generate authentication signature using AK/SK mechanism
 * Based on: https://developer.huawei.com/consumer/cn/doc/service/pushmessage-0000002505761436
 *
 * Signature format: Base64(HMAC-SHA256(secretKey, ts))
 */
export class XiaoYiAuth {
  private ak: string;
  private sk: string;
  private agentId: string;

  constructor(ak: string, sk: string, agentId: string) {
    this.ak = ak;
    this.sk = sk;
    this.agentId = agentId;
  }

  /**
   * Generate authentication credentials with signature
   */
  generateAuthCredentials(): AuthCredentials {
    const timestamp = Date.now();
    const signature = this.generateSignature(timestamp.toString());

    return {
      ak: this.ak,
      sk: this.sk,
      timestamp,
      signature,
    };
  }

  /**
   * Generate HMAC-SHA256 signature
   * Format: Base64(HMAC-SHA256(secretKey, ts))
   * Reference: https://developer.huawei.com/consumer/cn/doc/service/pushmessage-0000002505761436
   * @param timestamp - Timestamp as string (e.g., "1514764800000")
   */
  private generateSignature(timestamp: string): string {
    // HMAC-SHA256(secretKey, ts)
    const hmac = crypto.createHmac("sha256", this.sk);
    hmac.update(timestamp);
    const digest = hmac.digest();

    // Base64 encode
    return digest.toString("base64");
  }

  /**
   * Verify if credentials are valid
   */
  verifyCredentials(credentials: AuthCredentials): boolean {
    const expectedSignature = this.generateSignature(credentials.timestamp.toString());
    return credentials.signature === expectedSignature;
  }

  /**
   * Generate authentication headers for WebSocket connection
   */
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

  /**
   * Generate authentication message for WebSocket (legacy, kept for compatibility)
   */
  generateAuthMessage(): any {
    const credentials = this.generateAuthCredentials();
    return {
      type: "auth",
      ak: credentials.ak,
      agentId: this.agentId,
      timestamp: credentials.timestamp,
      signature: credentials.signature,
    };
  }
}
