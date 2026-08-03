import { describe, expect, it } from "vitest";
import type { TtlReading } from "../src/rpc/ttl.js";
import { instanceLedgerKey } from "../src/rpc/keys.js";
import { decideMaintenance, effectiveThreshold } from "../src/keeper/policy.js";

/** The long_escrow example as deployed to testnet. Used only to build a real key. */
const ESCROW = "CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6";

function reading(description: string, remaining: number, threshold = 100_000): TtlReading {
  return {
    // A real key rather than a cast placeholder. `undefined as unknown as
    // xdr.LedgerKey` lies to the type checker, and the test would crash oddly
    // rather than fail clearly if the policy ever read this field.
    key: instanceLedgerKey(ESCROW),
    keyId: `id:${description}`,
    description,
    durability: "persistent",
    liveUntilLedgerSeq: remaining > 0 ? remaining + 1_000 : null,
    remaining,
    status: remaining <= 0 ? "archived" : remaining < threshold ? "low" : "ok",
  };
}

describe("effectiveThreshold", () => {
  it("uses the registered value when it is set", () => {
    expect(effectiveThreshold(250_000, 100_000)).toBe(250_000);
  });

  it("falls back when the registered value is zero", () => {
    expect(effectiveThreshold(0, 100_000)).toBe(100_000);
  });

  it("falls back on a negative registered value", () => {
    expect(effectiveThreshold(-1, 100_000)).toBe(100_000);
  });
});

describe("decideMaintenance", () => {
  it("does not need maintenance when every key is healthy", () => {
    const decision = decideMaintenance(
      [reading("instance", 400_000), reading("Balance", 300_000)],
      100_000,
    );
    expect(decision.needed).toBe(false);
    expect(decision.lowKeys).toEqual([]);
    expect(decision.archivedKeys).toEqual([]);
  });

  it("needs maintenance when one key is below threshold", () => {
    const decision = decideMaintenance(
      [reading("instance", 400_000), reading("Balance", 50_000)],
      100_000,
    );
    expect(decision.needed).toBe(true);
    expect(decision.lowKeys).toEqual(["Balance"]);
  });

  it("needs maintenance when a key is archived", () => {
    const decision = decideMaintenance(
      [reading("instance", 400_000), reading("Milestones", 0)],
      100_000,
    );
    expect(decision.needed).toBe(true);
    expect(decision.archivedKeys).toEqual(["Milestones"]);
  });

  it("treats exactly at threshold as healthy", () => {
    const decision = decideMaintenance([reading("instance", 100_000)], 100_000);
    expect(decision.needed).toBe(false);
  });

  it("does not need maintenance for an empty reading set", () => {
    const decision = decideMaintenance([], 100_000);
    expect(decision.needed).toBe(false);
    expect(decision.reason).toMatch(/no keys/i);
  });

  it("reports every low key, not just the first", () => {
    const decision = decideMaintenance(
      [reading("Balance", 10_000), reading("Milestones", 20_000)],
      100_000,
    );
    expect(decision.lowKeys).toEqual(["Balance", "Milestones"]);
  });

  it("gives a reason naming the counts", () => {
    const decision = decideMaintenance(
      [reading("Balance", 10_000), reading("Milestones", 0)],
      100_000,
    );
    expect(decision.reason).toContain("1 low");
    expect(decision.reason).toContain("1 archived");
  });
});
