/**
 * Runs distinct inbound messages immediately while suppressing an in-flight replay.
 * OpenClaw owns per-session queueing so active runs can receive steer messages.
 */
export function createXYMessageRunner(onError: (error: unknown) => void) {
  const activeMessages = new Set<string>();

  return {
    run(messageKey: string, task: () => Promise<void>): boolean {
      if (activeMessages.has(messageKey)) {
        return false;
      }

      activeMessages.add(messageKey);
      void task()
        .catch(onError)
        .finally(() => activeMessages.delete(messageKey));
      return true;
    },
    clear: () => activeMessages.clear(),
    size: () => activeMessages.size,
  };
}
