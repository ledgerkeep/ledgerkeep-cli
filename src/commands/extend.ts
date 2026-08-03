import { xdr } from "@stellar/stellar-sdk";
import { loadConfig, loadKeypair } from "../config.js";
import { log } from "../log.js";
import { makeServer } from "../rpc/client.js";
import { contractDataKey, instanceLedgerKey, parseScValFromHexOrBase64 } from "../rpc/keys.js";
import { extendViaContract } from "../ops/extendViaContract.js";
import { extendViaFootprint } from "../ops/extendViaFootprint.js";

export interface ExtendOptions {
  footprint: boolean;
  key: string[];
  durability: "persistent" | "temporary";
}

/**
 * Extend one contract's TTL.
 *
 * Default is Path A: call the contract's own permissionless `extend_all`, which
 * records maintenance in `lk_state` and makes the keeper eligible for a tip.
 * `--footprint` selects Path B instead: a raw `extendFootprintTtl` against
 * specific ledger keys, which works on any contract but records nothing and earns
 * nothing.
 *
 * Returns the exit code.
 */
export async function runExtend(contractId: string, options: ExtendOptions): Promise<number> {
  const config = loadConfig();
  const server = makeServer(config.rpcUrl);
  const keypair = loadKeypair(config);

  if (options.footprint) {
    const durability =
      options.durability === "temporary"
        ? xdr.ContractDataDurability.temporary()
        : xdr.ContractDataDurability.persistent();

    const keys = [
      instanceLedgerKey(contractId),
      ...options.key.map((raw) =>
        contractDataKey(contractId, parseScValFromHexOrBase64(raw), durability),
      ),
    ];

    log.info("extending via raw footprint", {
      contract: contractId,
      path: "B",
      keys: keys.length,
      extendTo: config.extendTo,
      note: "this records no maintenance and earns no tip",
    });

    const result = await extendViaFootprint({
      server,
      networkPassphrase: config.networkPassphrase,
      keypair,
      keys,
      extendTo: config.extendTo,
    });

    log.info("extended", {
      contract: contractId,
      path: "B",
      hash: result.hash,
      minResourceFee: result.minResourceFee,
    });
    return 0;
  }

  log.info("extending via contract extend_all", { contract: contractId, path: "A" });

  const result = await extendViaContract({
    server,
    networkPassphrase: config.networkPassphrase,
    contractId,
    keypair,
  });

  log.info("extended", {
    contract: contractId,
    path: "A",
    hash: result.hash,
    minResourceFee: result.minResourceFee,
    footprintKeys: result.footprint.length,
  });
  return 0;
}
