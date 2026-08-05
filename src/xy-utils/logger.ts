// Logging utilities for XY channel
import { getXYRuntime } from "../runtime.js";

type LogLevel = "info" | "warn" | "error" | "debug";

/**
 * Log a message using the OpenClaw runtime logger.
 */
function logMessage(level: LogLevel, message: string, ...args: unknown[]): void {
  try {
    const runtimeLogger = getXYRuntime().logging.getChildLogger({
      channel: "xiaoyi",
    });
    const logFn = runtimeLogger[level] ?? runtimeLogger.info;
    const meta = args.length > 0 ? { args } : undefined;
    logFn(`[XY] ${message}`, meta);
  } catch (error) {
    const fallback = level === "info" ? console.log : console[level];
    fallback(`[XY] ${message}`, ...args);
  }
}

export const logger = {
  log(message: string, ...args: unknown[]): void {
    logMessage("info", message, ...args);
  },

  warn(message: string, ...args: unknown[]): void {
    logMessage("warn", message, ...args);
  },

  error(message: string, ...args: unknown[]): void {
    logMessage("error", message, ...args);
  },

  debug(message: string, ...args: unknown[]): void {
    logMessage("debug", message, ...args);
  },
};
