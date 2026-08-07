import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { makeServer } from "../rpc/client.js";
import { instanceLedgerKey, manifestLedgerKeys } from "../rpc/keys.js";
import { readTtl } from "../rpc/ttl.js";
import { discoverAll } from "../registry/discover.js";
import { effectiveThreshold } from "../keeper/policy.js";

/**
 * Read one contract's TTL and report it.
 *
 * If the contract is registered, its whole manifest is scanned against its own
 * registered threshold. If it is not, only the instance entry is scanned, against
 * `LK_THRESHOLD`. Signs nothing and never reads the keeper key.
 *
 * Returns the exit code: 0 when every key is ok, 2 when any is low or archived.
 */
export async function runScan(contractId: string): Promise<number> {
  const config = loadConfig();
  const server = makeServer(config.rpcUrl);

  const entries = await discoverAll(server, config.registryId);
  const entry = entries.find((candidate) => candidate.contract === contractId);

  const threshold = entry
    ? effectiveThreshold(entry.threshold, config.threshold)
    : config.threshold;
  const keys = entry
    ? manifestLedgerKeys(contractId, entry.keysXdr)
    : [instanceLedgerKey(contractId)];

  const { readings, latestLedger } = await readTtl(server, keys, threshold);

  log.info("scanned contract", {
    contract: contractId,
    registered: entry !== undefined,
    threshold,
    latestLedger,
    keys: readings.length,
  });

  for (const reading of readings) {
    const fields = {
      contract: contractId,
      key: reading.description,
      durability: reading.durability,
      liveUntilLedgerSeq: reading.liveUntilLedgerSeq,
      remaining: reading.remaining,
      status: reading.status,
    };
    if (reading.status === "ok") {
      log.info("key ok", fields);
    } else if (reading.status === "low") {
      log.warn("key low", fields);
    } else if (reading.status === "archived") {
      log.warn("key archived", {
        ...fields,
        note: "the next extend_all restores this automatically under Protocol 23",
      });
    } else {
      // Exhaustive: a new TtlStatus variant must fail the build here rather
      // than be silently reported as archived. Unreachable today.
      const unhandled: never = reading.status;
      throw new Error(`unhandled TtlStatus ${unhandled} for key ${reading.description}`);
    }
  }

  if (!entry) {
    log.info("contract is not in the registry", {
      contract: contractId,
      note: "scanned the instance entry only; register it to scan its full manifest",
    });
  }

  return readings.some((reading) => reading.status !== "ok") ? 2 : 0;
}
