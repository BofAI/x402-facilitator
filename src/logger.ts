/**
 * Minimal structured logger. Swap for pino/winston in phase 2 if needed.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

let fileStream: WriteStream | null = null;

/**
 * Set the minimum log level that will be emitted.
 *
 * @param level - The minimum level ("debug" | "info" | "warn" | "error").
 */
export function setLogLevel(level: Level): void {
  threshold = ORDER[level] ?? ORDER.info;
}

/**
 * Enable file logging: every emitted line is also appended to `path` (the
 * console output is unchanged). Call once at startup. The file name is fixed —
 * the same file is appended to across restarts. Creates parent dirs as needed.
 *
 * @param path - Destination log file path (resolved by the caller).
 */
export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  fileStream = createWriteStream(path, { flags: "a" });
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta ?? {}) };
  const text = JSON.stringify(line);
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(text);
  fileStream?.write(`${text}\n`);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

/**
 * Bridge the `@bankofai/x402-*` SDK's process-global logger onto this app's
 * logger so SDK output lands in the same structured JSON stream and respects
 * {@link setLogLevel}. Pass the result to the SDK's `setLogger(...)` once at
 * startup (see `src/index.ts`).
 *
 * The SDK's `Logger` is `console`-shaped (variadic). Its call sites — including
 * the facilitator verify/settle hooks — use `log.<level>("message", metaObject)`,
 * so the first string becomes `msg` and a trailing plain object becomes `meta`;
 * any other arguments are preserved under `meta.args`.
 *
 * @returns A console-shaped logger forwarding to {@link logger}.
 */
export function toSdkLogger(): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} {
  const forward =
    (level: Level) =>
    (...args: unknown[]): void => {
      const [first, ...rest] = args;
      const msg = typeof first === "string" ? first : JSON.stringify(first);
      const isPlainObject = (v: unknown): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      let meta: Record<string, unknown> | undefined;
      if (rest.length === 1 && isPlainObject(rest[0])) {
        meta = rest[0];
      } else if (rest.length > 0) {
        meta = { args: rest };
      }
      emit(level, msg, meta);
    };
  return {
    debug: forward("debug"),
    info: forward("info"),
    warn: forward("warn"),
    error: forward("error"),
  };
}
