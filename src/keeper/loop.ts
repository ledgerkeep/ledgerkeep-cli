import type { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { manifestLedgerKeys } from "../rpc/keys.js";
import { readTtl, type TtlReading } from "../rpc/ttl.js";
import { discoverAll, type ManifestEntry } from "../registry/discover.js";
import { extendViaContract, simulateExtendAll } from "../ops/extendViaContract.js";
import { decideMaintenance, effectiveThreshold } from "./policy.js";
import { footprintDrift, ttlDrift } from "./drift.js";
import { type FutilityTracker, obligatedReadings } from "./futility.js";

/** Everything a tick needs, built once at daemon start. */
export interface KeeperContext {
  config: Config;
  server: rpc.Server;
  keypair: Keypair;
  signal: AbortSignal;
  futility: FutilityTracker;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Did a paid extension move anything at all?
 *
 * The test is deliberately generous: one key gaining life anywhere makes the fee
 * worth paying, so only a transaction that moved nothing counts as futile. A
 * partial success — three low keys, two extended — must not trigger backoff, or
 * the daemon would ration maintenance it is actually performing.
 */
function anyKeyImproved(before: TtlReading[], after: TtlReading[]): boolean {
  const previous = new Map(before.map((reading) => [reading.keyId, reading.remaining]));
  return after.some((reading) => {
    const was = previous.get(reading.keyId);
    return was !== undefined && reading.remaining > was;
  });
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

  // Checked before any RPC. A contract in a backoff window has already had its
  // drift reported on the tick that opened the window, so re-reading it every
  // minute to print the same warning buys the operator nothing.
  const backoff = ctx.futility.consumeBackoff(contract);
  if (backoff.skip) {
    log.info("backing off", {
      contract,
      action: "skip",
      result: "ok",
      reason: "previous extensions changed nothing",
      consecutiveFutile: backoff.consecutiveFutile,
      ticksRemaining: backoff.ticksRemaining,
    });
    return;
  }

  const threshold = effectiveThreshold(entry.threshold, config.threshold);
  const keys = manifestLedgerKeys(contract, entry.keysXdr);

  const { readings: before } = await readTtl(server, keys, threshold);

  // Primary drift signal: free, and independent of whether TTL is low. The
  // footprint is kept rather than only reported, because it is also the evidence
  // for whether an extension could achieve anything.
  let footprint: xdr.LedgerKey[] | null = null;
  try {
    const simulated = await simulateExtendAll({
      server,
      networkPassphrase: config.networkPassphrase,
      contractId: contract,
      keeper: keypair.publicKey(),
    });
    footprint = simulated.footprint;
    for (const finding of footprintDrift(keys, footprint)) {
      log.warn("manifest drift", {
        contract,
        kind: finding.kind,
        keyId: finding.keyId,
        description: finding.description,
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

  // Something is below threshold. Whether extending would help is a separate
  // question, and the footprint answers it for free. A manifest key the contract
  // no longer extends will sit below threshold on every tick from now until the
  // owner republishes the manifest; without this gate that is one paid
  // transaction per tick, forever, each one logging exactly why it was pointless.
  //
  // A failed simulation leaves no footprint, and an absent signal is not evidence
  // of futility, so that case falls through to the extension it would have made
  // anyway.
  if (footprint !== null) {
    const obligated = obligatedReadings(before, footprint);
    if (!decideMaintenance(obligated, threshold).needed) {
      log.warn("skipping futile extension", {
        contract,
        action: "skip",
        result: "ok",
        reason: "no key below threshold appears in the extend_all footprint",
        lowKeys: decision.lowKeys,
        archivedKeys: decision.archivedKeys,
        footprintKeys: footprint.length,
      });
      return;
    }
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
      keyId: finding.keyId,
      description: finding.description,
      detail: finding.detail,
    });
  }

  // The footprint filter above catches futility it can predict. This catches the
  // rest: a key the contract reads but never extends is in the footprint and
  // passes that gate, and a failed simulation skips the gate entirely. Both end
  // here, having paid a fee for nothing.
  if (anyKeyImproved(before, after)) {
    ctx.futility.recordProductive(contract);
  } else {
    const record = ctx.futility.recordFutile(contract);
    log.warn("extension changed nothing", {
      contract,
      action: "extend",
      result: "futile",
      hash,
      consecutiveFutile: record.consecutiveFutile,
      ticksToSkip: record.ticksToSkip,
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
  // Logged before discovery rather than after it. Discovery is a network round
  // trip that takes seconds, so a "tick start" printed only once it returns leaves
  // the tick's opening seconds silent. That gap is actively misleading: a SIGINT
  // arriving mid-discovery prints "stopping" before "tick start", which reads as
  // though the daemon began a whole new tick after being told to stop. It does not
  // — but an operator watching a funded keeper cannot tell that from the log.
  log.info("tick start", {});

  let entries: ManifestEntry[];
  try {
    entries = await discoverAll(ctx.server, ctx.config.registryId);
  } catch (cause) {
    log.error("registry discovery failed", { error: errorMessage(cause) });
    return;
  }

  log.info("registry discovered", { contracts: entries.length });

  for (const [index, entry] of entries.entries()) {
    if (ctx.signal.aborted) {
      log.info("tick stopped early", {
        reason: "aborted",
        contractsMaintained: index,
        contractsRemaining: entries.length - index,
      });
      return;
    }

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
