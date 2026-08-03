import { Keypair } from "@stellar/stellar-sdk";

/** Extra structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

type Level = "info" | "warn" | "error";

/** Nested fields deeper than this are replaced rather than walked. */
const MAX_DEPTH = 6;

/**
 * Rewrite one value into something safe to serialize.
 *
 * This walks nested objects and arrays rather than only the top level. A
 * top-level-only guard is not enough: `JSON.stringify` recurses, so a `Keypair`
 * at `{ ctx: { signer } }` or `{ signers: [k] }` reaches the output just as
 * readily as one passed directly.
 *
 * - `bigint` is stringified, because `JSON.stringify` throws on it and ledger
 *   math elsewhere may hand us one.
 * - A `Keypair` becomes its public key. `JSON.stringify` on one emits
 *   `_secretSeed` and `_secretKey` as plain byte arrays — the whole secret, in
 *   recoverable form, with no `S...` string present to notice.
 * - Any byte view, `Buffer` included, becomes a length. The logger cannot tell
 *   a harmless buffer from 32 bytes of seed, and nothing here needs raw bytes.
 * - An `Error` becomes name and message. A stack makes a daemon tail unreadable.
 *
 * `seen` tracks the current path only, so a value repeated in two sibling fields
 * renders twice rather than being mislabelled as a cycle.
 */
function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Keypair) return value.publicKey();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (ArrayBuffer.isView(value)) return `<${value.byteLength} bytes>`;
  if (value === null || typeof value !== "object") return value;

  if (depth >= MAX_DEPTH) return "<max depth>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redact(item, seen, depth + 1));
    }
    const out: LogFields = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redact(nested, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Serialize one line of JSON.
 *
 * A logging failure must never take down a running daemon, so both the walk and
 * the stringify are wrapped. `redact` already replaces cycles, so the fallback
 * covers what is left: a throwing getter, or a `toJSON` that misbehaves.
 */
function serialize(level: Level, msg: string, fields: LogFields): string {
  const ts = new Date().toISOString();
  try {
    const seen = new WeakSet<object>();
    const record: LogFields = { ts, level, msg };
    for (const [key, value] of Object.entries(fields)) {
      record[key] = redact(value, seen, 0);
    }
    return JSON.stringify(record);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return JSON.stringify({
      ts,
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
 * signing failures. Callers pass plain fields; a `Keypair` or byte buffer that
 * reaches here, at any nesting depth, is redacted before it can be written.
 */
export const log = {
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};
