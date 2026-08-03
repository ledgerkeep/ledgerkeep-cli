import type { Keypair, rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { manifestLedgerKeys } from "../rpc/keys.js";
import { readTtl } from "../rpc/ttl.js";
import { discoverAll, type ManifestEntry } from "../registry/discover.js";
import { extendViaContract, simulateExtendAll } from "../ops/extendViaContract.js";
import { decideMaintenance, effectiveThreshold } from "./policy.js";
import { footprintDrift, ttlDrift } from "./drift.js";

/** Everything a tick needs, built once at daemon start. */
export interface KeeperContext {
  config: Config;
  server: rpc.Server;
  keypair: Keypair;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The least remaining life across a set of readings.
 *
 * Guards the empty case: `Math.min()` with no arguments returns `Infinity`, which
 * would serialize into a log line as `null` and read as though the contract had
 * no TTL problem at all.
 */
function lowest(readings: { remaining: number }[]): number {
  return readings.length === 0 ? 0 : Math.min(...readings.map((r) => r.remaining));
}

/**
 * Scan one contract, report drift, and extend it if it needs it.
 *
 * Ordering matters. Drift is checked by simulation first, because that costs
 * nothing and works whether or not the contract needs maintenance. The TTL diff
 * runs only after a real extension, since it has nothing to compare otherwise.
 */
export async function maintainContract(ctx: KeeperContext, entry: ManifestEntry): Promise<void> {
  const { config, server, keypair } = ctx;
  const contract = entry.contract;
  const threshold = effectiveThreshold(entry.threshold, config.threshold);
  const keys = manifestLedgerKeys(contract, entry.keysXdr);

  const { readings: before } = await readTtl(server, keys, threshold);

  // Primary drift signal: free, and independent of whether TTL is low.
  try {
    const { footprint } = await simulateExtendAll({
      server,
      networkPassphrase: config.networkPassphrase,
      contractId: contract,
      keeper: keypair.publicKey(),
    });
    for (const finding of footprintDrift(keys, footprint)) {
      log.warn("manifest drift", {
        contract,
        kind: finding.kind,
        key: finding.description,
        detail: finding.detail,
      });
    }
  } catch (cause) {
    log.error("drift simulation failed", { contract, error: errorMessage(cause) });
  }

  const decision = decideMaintenance(before, threshold);
  if (!decision.needed) {
    log.info("no maintenance needed", {
      contract,
      action: "skip",
      result: "ok",
      reason: decision.reason,
      remainingBefore: lowest(before),
    });
    return;
  }

  log.info("maintenance needed", {
    contract,
    action: "extend",
    reason: decision.reason,
    lowKeys: decision.lowKeys,
    archivedKeys: decision.archivedKeys,
  });

  let hash: string;
  try {
    const result = await extendViaContract({
      server,
      networkPassphrase: config.networkPassphrase,
      contractId: contract,
      keypair,
    });
    hash = result.hash;
  } catch (cause) {
    log.error("extend_all failed", {
      contract,
      action: "extend",
      result: "error",
      error: errorMessage(cause),
    });
    return;
  }

  const { readings: after } = await readTtl(server, keys, threshold);

  for (const finding of ttlDrift(before, after, threshold)) {
    log.warn("manifest drift", {
      contract,
      kind: finding.kind,
      key: finding.description,
      detail: finding.detail,
    });
  }

  log.info("maintained contract", {
    contract,
    action: "extend",
    result: "success",
    hash,
    remainingBefore: lowest(before),
    remainingAfter: lowest(after),
  });
}

/** One pass over every registered contract. */
export async function runTick(ctx: KeeperContext): Promise<void> {
  let entries: ManifestEntry[];
  try {
    entries = await discoverAll(ctx.server, ctx.config.registryId);
  } catch (cause) {
    log.error("registry discovery failed", { error: errorMessage(cause) });
    return;
  }

  log.info("tick start", { contracts: entries.length });

  for (const entry of entries) {
    try {
      await maintainContract(ctx, entry);
    } catch (cause) {
      // One contract must never take the daemon down.
      log.error("contract failed", {
        contract: entry.contract,
        result: "error",
        error: errorMessage(cause),
      });
    }
  }

  log.info("tick end", { contracts: entries.length });
}

/**
 * Run ticks until the signal aborts.
 *
 * The interval is a delay *between* ticks rather than a fixed-rate timer, so a
 * tick that runs longer than the interval cannot overlap the next one.
 */
export async function runLoop(ctx: KeeperContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await runTick(ctx);
    if (signal.aborted) break;

    // The abort listener has to come off on the timeout path too. `{ once: true }`
    // removes it only if the event actually fires, and in the common case it never
    // does — the tick simply times out. Without the explicit removal, every
    // completed tick leaves a listener attached for the life of the process:
    // measured at 200 retained listeners after 200 ticks, against 0 with it. This
    // is the one component built to run forever, so it is the one place where
    // unbounded growth cannot be shrugged off.
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ctx.config.scanIntervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  log.info("daemon stopped", {});
}
