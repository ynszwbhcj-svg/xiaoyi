// Session management utilities
import type { SessionBinding } from "../types.js";

/**
 * Session binding cache.
 * Tracks active sessions.
 */
class SessionManager {
  private bindings = new Map<string, SessionBinding>();

  bind(sessionId: string): void {
    this.bindings.set(sessionId, {
      sessionId,
      boundAt: Date.now(),
    });
  }

  getBinding(sessionId: string): SessionBinding | null {
    return this.bindings.get(sessionId) ?? null;
  }

  isBound(sessionId: string): boolean {
    return this.bindings.has(sessionId);
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  clear(): void {
    this.bindings.clear();
  }

  getAll(): SessionBinding[] {
    return Array.from(this.bindings.values());
  }
}

// Singleton instance
export const sessionManager = new SessionManager();
