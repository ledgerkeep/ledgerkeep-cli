import type { xdr } from "@stellar/stellar-sdk";
import { keyId } from "../rpc/keys.js";
import type { TtlReading } from "../rpc/ttl.js";

/**
 * The readings for keys the contract's own `extend_all` actually touches.
 *
 * A manifest is advisory. It can declare a key the compiled contract stopped
 * extending long ago, and a keeper that judges maintenance by the manifest alone
 * will pay for an `extend_all` that provably cannot move the key which triggered
 * it — every tick, forever. Simulating first and keeping only the keys in the
 * footprint is what stops that, and the simulation is free.
 *
 * Two limits, both deliberate. The footprint unions read-only and read-write, so
 * a key the contract merely reads still counts as obligated here; the fee is real
 * and the extension is not, which is why the tracker below also watches outcomes.
 * And a key the contract extends without declaring has no reading to filter, so
 * skipping can leave it unmaintained — that case is reported as
 * `manifest-omits-extended` drift, and repairing it means republishing the
 * manifest, which is the contract owner's decision rather than the keeper's.
 */
export function obligatedReadings(
  readings: TtlReading[],
  footprint: xdr.LedgerKey[],
): TtlReading[] {
  const extended = new Set(footprint.map(keyId));
  return readings.filter((reading) => extended.has(reading.keyId));
}

/** The longest a persistently futile contract is skipped for, in ticks. */
export const MAX_BACKOFF_TICKS = 60;

/**
 * How many ticks to skip after `consecutive` futile extensions in a row.
 *
 * Doubling, capped. At the default one-minute tick this walks 1, 2, 4 ... up to
 * an hour between attempts, so a contract whose manifest stays broken costs on
 * the order of twenty transactions a day rather than fourteen hundred. The cap
 * exists because the fault is repairable off-chain at any moment: the owner may
 * republish the manifest, and the daemon has to notice within a shift rather
 * than never.
 */
export function backoffTicks(consecutive: number): number {
  if (consecutive < 1) return 0;
  return Math.min(2 ** (consecutive - 1), MAX_BACKOFF_TICKS);
}

/** What a backoff check found for one contract. */
export interface BackoffCheck {
  skip: boolean;
  ticksRemaining: number;
  consecutiveFutile: number;
}

/** The window opened by one futile extension. */
export interface FutilityRecord {
  consecutiveFutile: number;
  ticksToSkip: number;
}

interface ContractState {
  consecutive: number;
  skipsLeft: number;
}

/**
 * Per-contract memory of extensions that changed nothing.
 *
 * `obligatedReadings` catches the futility that can be predicted from a
 * footprint. This catches the rest — a key present read-only, a simulation that
 * failed so nothing could be filtered — by watching what a paid extension
 * actually achieved and refusing to repeat it at full rate.
 *
 * Nothing is persisted. A restarted daemon retries every contract once, which is
 * the right behaviour when the restart may itself be the fix.
 */
export class FutilityTracker {
  private readonly state = new Map<string, ContractState>();

  /**
   * Take one tick off this contract's backoff window.
   *
   * Call once per contract per tick. It reports whether to skip and consumes the
   * tick in the same step, so a caller cannot check without paying the tick.
   */
  consumeBackoff(contract: string): BackoffCheck {
    const entry = this.state.get(contract);
    if (entry === undefined || entry.skipsLeft <= 0) {
      return { skip: false, ticksRemaining: 0, consecutiveFutile: entry?.consecutive ?? 0 };
    }
    entry.skipsLeft -= 1;
    return { skip: true, ticksRemaining: entry.skipsLeft, consecutiveFutile: entry.consecutive };
  }

  /** Record that a paid extension moved nothing, and open the next window. */
  recordFutile(contract: string): FutilityRecord {
    const consecutive = (this.state.get(contract)?.consecutive ?? 0) + 1;
    const ticksToSkip = backoffTicks(consecutive);
    this.state.set(contract, { consecutive, skipsLeft: ticksToSkip });
    return { consecutiveFutile: consecutive, ticksToSkip };
  }

  /** Record that an extension moved something. Clears any backoff window. */
  recordProductive(contract: string): void {
    this.state.delete(contract);
  }
}
