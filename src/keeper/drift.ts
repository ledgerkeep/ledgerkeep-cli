import { xdr } from "@stellar/stellar-sdk";
import { describeScVal, keyId } from "../rpc/keys.js";
import type { TtlReading } from "../rpc/ttl.js";

/**
 * The two ways a published manifest can disagree with a compiled contract.
 *
 * `manifest-declares-unextended` — the manifest lists a key the contract does not
 * extend. A keeper watching that key is watching something nothing maintains.
 *
 * `manifest-omits-extended` — the contract extends a key the manifest never
 * declared. A keeper scanning only the manifest is blind to it.
 */
export type DriftKind = "manifest-declares-unextended" | "manifest-omits-extended";

/** One disagreement, ready to log. */
export interface DriftFinding {
  kind: DriftKind;
  keyId: string;
  description: string;
  detail: string;
}

function describeKey(key: xdr.LedgerKey): string {
  return key.switch().name === "contractData"
    ? describeScVal(key.contractData().key())
    : key.switch().name;
}

/**
 * Compare the published manifest against the contract's real footprint.
 *
 * The footprint comes from simulating `extend_all`, so it is the set of ledger
 * keys the compiled contract actually touches. This costs no fee, needs no
 * submission, and runs on every tick regardless of how healthy the contract is —
 * which is why it is the primary drift signal rather than the TTL diff below.
 */
export function footprintDrift(
  manifestKeys: xdr.LedgerKey[],
  footprintKeys: xdr.LedgerKey[],
): DriftFinding[] {
  const manifest = new Map(manifestKeys.map((key) => [keyId(key), key]));
  const footprint = new Map(footprintKeys.map((key) => [keyId(key), key]));
  const findings: DriftFinding[] = [];

  for (const [id, key] of manifest) {
    if (!footprint.has(id)) {
      findings.push({
        kind: "manifest-declares-unextended",
        keyId: id,
        description: describeKey(key),
        detail: "declared in the registry manifest but absent from the extend_all footprint",
      });
    }
  }

  for (const [id, key] of footprint) {
    if (!manifest.has(id)) {
      findings.push({
        kind: "manifest-omits-extended",
        keyId: id,
        description: describeKey(key),
        detail: "extended by the contract but absent from the registry manifest",
      });
    }
  }

  return findings;
}

/**
 * Confirm drift from observed time-to-live, after a real `extend_all` landed.
 *
 * Only keys that were **below the threshold** beforehand are judged. Soroban's
 * `extend_ttl` is conditional and does nothing when an entry is already above the
 * threshold, so a healthy key that did not move is behaving correctly. Judging
 * every key here would report drift on nearly every tick of a healthy daemon.
 */
export function ttlDrift(
  before: TtlReading[],
  after: TtlReading[],
  threshold: number,
): DriftFinding[] {
  const afterById = new Map(after.map((reading) => [reading.keyId, reading]));
  const findings: DriftFinding[] = [];

  for (const previous of before) {
    // Above threshold: the contract was under no obligation to touch this.
    if (previous.remaining >= threshold) continue;

    const current = afterById.get(previous.keyId);
    if (current === undefined) continue;
    if (current.remaining > previous.remaining) continue;

    findings.push({
      kind: "manifest-declares-unextended",
      keyId: previous.keyId,
      description: previous.description,
      detail:
        `was below threshold ${threshold} at ${previous.remaining} ledgers and did not ` +
        `increase after a successful extend_all (now ${current.remaining})`,
    });
  }

  return findings;
}
