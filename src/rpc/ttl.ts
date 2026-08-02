import { rpc, xdr } from "@stellar/stellar-sdk";
import { describeScVal, keyId } from "./keys.js";

/** How healthy one storage entry is. */
export type TtlStatus = "ok" | "low" | "archived";

/** One entry's observed time-to-live. */
export interface TtlReading {
  key: xdr.LedgerKey;
  keyId: string;
  description: string;
  durability: string;
  liveUntilLedgerSeq: number | null;
  remaining: number;
  status: TtlStatus;
}

/**
 * The RPC caps how many keys one `getLedgerEntries` call accepts. Requests are
 * chunked below that cap rather than relying on the server's limit.
 */
const MAX_KEYS_PER_REQUEST = 100;

/**
 * Ledgers of life left in an entry.
 *
 * A missing `liveUntilLedgerSeq` means the RPC has no live entry for the key, and
 * a live-until at or before the latest ledger means it has expired. Both report
 * zero; neither is allowed to go negative, because callers compare against a
 * threshold and a negative value would sort below every other reading for no
 * useful reason.
 */
export function remainingLife(
  liveUntilLedgerSeq: number | undefined,
  latestLedger: number,
): number {
  if (liveUntilLedgerSeq === undefined) return 0;
  return Math.max(0, liveUntilLedgerSeq - latestLedger);
}

/** Classify remaining life against a threshold. */
export function classify(remaining: number, threshold: number): TtlStatus {
  if (remaining <= 0) return "archived";
  if (remaining < threshold) return "low";
  return "ok";
}

/** The `entries` shape `buildReadings` needs. Structural, so tests can fake it. */
interface EntryLike {
  key: xdr.LedgerKey;
  liveUntilLedgerSeq?: number;
}

function durabilityName(key: xdr.LedgerKey): string {
  if (key.switch().name !== "contractData") return "unknown";
  return key.contractData().durability().name;
}

/**
 * Pair every requested key with its entry.
 *
 * The RPC omits keys it has no entry for, so results are matched by key rather
 * than by position, and a key with no match is reported archived. Output order
 * follows the requested order so a scan table is stable across runs.
 */
export function buildReadings(
  keys: xdr.LedgerKey[],
  entries: EntryLike[],
  latestLedger: number,
  threshold: number,
): TtlReading[] {
  const byId = new Map<string, EntryLike>();
  for (const entry of entries) {
    byId.set(keyId(entry.key), entry);
  }

  return keys.map((key) => {
    const id = keyId(key);
    const entry = byId.get(id);
    const liveUntil = entry?.liveUntilLedgerSeq;
    const remaining = remainingLife(liveUntil, latestLedger);
    return {
      key,
      keyId: id,
      description:
        key.switch().name === "contractData"
          ? describeScVal(key.contractData().key())
          : key.switch().name,
      durability: durabilityName(key),
      liveUntilLedgerSeq: liveUntil ?? null,
      remaining,
      status: classify(remaining, threshold),
    };
  });
}

/**
 * Read TTL for a batch of ledger keys.
 *
 * The only function in this module that performs I/O.
 */
export async function readTtl(
  server: rpc.Server,
  keys: xdr.LedgerKey[],
  threshold: number,
): Promise<{ readings: TtlReading[]; latestLedger: number }> {
  if (keys.length === 0) {
    return { readings: [], latestLedger: 0 };
  }

  const collected: EntryLike[] = [];
  let latestLedger = 0;

  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_REQUEST) {
    const chunk = keys.slice(i, i + MAX_KEYS_PER_REQUEST);
    let response: rpc.Api.GetLedgerEntriesResponse;
    try {
      response = await server.getLedgerEntries(...chunk);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`getLedgerEntries failed: ${message}`, { cause });
    }
    collected.push(...response.entries);
    latestLedger = Math.max(latestLedger, response.latestLedger);
  }

  return { readings: buildReadings(keys, collected, latestLedger, threshold), latestLedger };
}
