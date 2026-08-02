/* eslint-disable no-console */

/** Extra structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

type Level = "info" | "warn" | "error";

/**
 * Serialize one line of JSON.
 *
 * `bigint` is stringified because `JSON.stringify` throws on it, and ledger math
 * elsewhere may hand us one. Errors are reduced to name and message; a stack
 * would make the output unreadable in a daemon tail.
 *
 * `JSON.stringify` can still throw on a circular object even after this
 * normalization. A logging failure must never take down a running daemon, so
 * the caller wraps the final stringify and falls back to a minimal line that
 * reports the failure instead of the original fields.
 */
function serialize(level: Level, msg: string, fields: LogFields): string {
  const record: LogFields = { ts: new Date().toISOString(), level, msg };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "bigint") {
      record[key] = value.toString();
    } else if (value instanceof Error) {
      record[key] = `${value.name}: ${value.message}`;
    } else {
      record[key] = value;
    }
  }
  try {
    return JSON.stringify(record);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return JSON.stringify({
      ts: record.ts,
      level,
      msg,
      logError: `failed to serialize fields: ${reason}`,
    });
  }
}

function emit(level: Level, msg: string, fields: LogFields = {}): void {
  const line = serialize(level, msg, fields);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * The only writer to stdout and stderr in this program.
 *
 * `info` marks actions, `warn` marks drift and low TTL, `error` marks RPC and
 * signing failures. Nothing here can reach a `Keypair`: callers pass plain
 * fields, and a `Keypair` would serialize to `{}` rather than a secret, but no
 * call site should pass one regardless.
 */
export const log = {
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};
