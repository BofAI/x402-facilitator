/**
 * Minimal structured logger. Swap for pino/winston in phase 2 if needed.
 */
export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

/**
 * Set the minimum log level that will be emitted.
 *
 * @param level - The minimum level ("debug" | "info" | "warn" | "error").
 */
export function setLogLevel(level: Level): void {
  threshold = ORDER[level] ?? ORDER.info;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta ?? {}) };
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
