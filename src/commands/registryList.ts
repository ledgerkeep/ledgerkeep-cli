import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { makeServer } from "../rpc/client.js";
import { discoverAll } from "../registry/discover.js";
import { effectiveThreshold } from "../keeper/policy.js";

/**
 * Print every contract registered in the registry.
 *
 * The registry self-registers in its own constructor, so it appears in this list.
 * Read-only; signs nothing and reads no key.
 */
export async function runRegistryList(): Promise<number> {
  const config = loadConfig();
  const server = makeServer(config.rpcUrl);

  const entries = await discoverAll(server, config.registryId);

  log.info("registry contents", {
    registry: config.registryId,
    count: entries.length,
  });

  for (const entry of entries) {
    log.info("registered contract", {
      contract: entry.contract,
      keyCount: entry.keysXdr.length,
      threshold: entry.threshold,
      effectiveThreshold: effectiveThreshold(entry.threshold, config.threshold),
      extendTo: entry.extendTo,
      registeredLedger: entry.registered,
      updatedLedger: entry.updated,
      isRegistryItself: entry.contract === config.registryId,
    });
  }

  return 0;
}
