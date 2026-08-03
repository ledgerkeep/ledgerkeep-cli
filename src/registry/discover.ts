import { contract as contractSpec, rpc } from "@stellar/stellar-sdk";

/** One contract's published maintenance manifest, decoded. */
export interface ManifestEntry {
  contract: string;
  keysXdr: Buffer[];
  threshold: number;
  extendTo: number;
  registered: number;
  updated: number;
}

/**
 * The registry rejects a `limit` above 50 with `LimitTooLarge`, so this is the
 * largest page it will serve.
 */
export const PAGE_LIMIT = 50;

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`registry entry is not an object: ${JSON.stringify(raw)}`);
  }
  return raw as Record<string, unknown>;
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`registry entry field ${field} is not an integer: ${String(value)}`);
}

function requireBytes(record: Record<string, unknown>, field: string): Buffer[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new Error(`registry entry field ${field} is not an array`);
  }
  return value.map((item, index) => {
    if (Buffer.isBuffer(item)) return item;
    if (item instanceof Uint8Array) return Buffer.from(item);
    throw new Error(`registry entry field ${field}[${index}] is not bytes`);
  });
}

/**
 * Convert one native-decoded `RegistryEntry` into our shape.
 *
 * The on-chain struct uses Rust field names, so `keys_xdr` and `extend_to` arrive
 * snake_case. `Bytes` decodes to a `Buffer` under Node but the check accepts any
 * `Uint8Array`, because that is the weaker guarantee the SDK actually makes.
 */
export function decodeEntry(raw: unknown): ManifestEntry {
  const record = asRecord(raw);
  const contract = record["contract"];
  if (typeof contract !== "string") {
    throw new Error("registry entry field contract is not an address string");
  }
  return {
    contract,
    keysXdr: requireBytes(record, "keys_xdr"),
    threshold: requireNumber(record, "threshold"),
    extendTo: requireNumber(record, "extend_to"),
    registered: requireNumber(record, "registered"),
    updated: requireNumber(record, "updated"),
  };
}

/**
 * Unwrap one page of registry entries.
 *
 * The registry's `page` returns a Rust `Result`, and the SDK decodes that into
 * its own `Ok`/`Err` wrapper rather than a bare list. Verified against the
 * deployed testnet registry, not assumed: a good page arrives as `Ok([...])`,
 * a `start` past the end arrives as `Ok([])`, and a `limit` above 50 fails
 * inside simulation with `Error(Contract, #105)` — so an oversized limit is a
 * thrown error from `queryContract`, never an `Err` value here.
 *
 * `count`, by contrast, returns a plain number. The two are not symmetric.
 */
export function unwrapPage(raw: unknown, start: number): unknown[] {
  if (raw instanceof contractSpec.Err) {
    throw new Error(
      `registry page at start=${start} returned an error: ${String(raw.unwrapErr())}`,
    );
  }
  const value = raw instanceof contractSpec.Ok ? raw.unwrap() : raw;
  if (!Array.isArray(value)) {
    throw new Error(`registry page at start=${start} did not return a list`);
  }
  return value;
}

/**
 * Read every registered contract.
 *
 * Pages through `count` and `page`. The registry self-registers in its own
 * constructor, so it appears in this list and is maintained like any other
 * contract.
 *
 * `queryContract` simulates against the SDK's null account, so this needs no
 * signing key and no funded account.
 */
export async function discoverAll(
  server: rpc.Server,
  registryId: string,
): Promise<ManifestEntry[]> {
  let total: number;
  try {
    const { result } = await server.queryContract<number>(registryId, "count");
    total = Number(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not read registry count from ${registryId}: ${message}`, { cause });
  }
  // A non-number here would make the loop below run zero times and return an
  // empty list, so a keeper daemon would report "0 contracts" and sit there
  // maintaining nothing while looking healthy. Fail loudly instead.
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`registry count from ${registryId} is not a whole number: ${String(total)}`);
  }

  const entries: ManifestEntry[] = [];
  for (let start = 0; start < total; start += PAGE_LIMIT) {
    let page: unknown;
    try {
      const { result } = await server.queryContract<unknown>(registryId, "page", {
        start,
        limit: PAGE_LIMIT,
      });
      page = result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`registry page at start=${start} failed: ${message}`, { cause });
    }

    const items = unwrapPage(page, start);
    if (items.length === 0) break;
    for (const item of items) {
      entries.push(decodeEntry(item));
    }
  }

  return entries;
}
