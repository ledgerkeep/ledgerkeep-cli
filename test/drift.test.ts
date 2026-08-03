import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { contractDataKey, instanceLedgerKey, keyId } from "../src/rpc/keys.js";
import type { TtlReading } from "../src/rpc/ttl.js";
import { footprintDrift, ttlDrift } from "../src/keeper/drift.js";

const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

function symbolKey(name: string): xdr.LedgerKey {
  return contractDataKey(
    CONTRACT,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
    xdr.ContractDataDurability.persistent(),
  );
}

function reading(key: xdr.LedgerKey, description: string, remaining: number): TtlReading {
  return {
    key,
    keyId: keyId(key),
    description,
    durability: "persistent",
    liveUntilLedgerSeq: remaining > 0 ? remaining + 1_000 : null,
    remaining,
    status: remaining <= 0 ? "archived" : remaining < 100_000 ? "low" : "ok",
  };
}

describe("footprintDrift", () => {
  it("finds nothing when the manifest and footprint agree", () => {
    const keys = [instanceLedgerKey(CONTRACT), symbolKey("Balance")];
    expect(footprintDrift(keys, keys)).toEqual([]);
  });

  it("flags a manifest key the contract never touches", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const stale = symbolKey("RemovedKey");
    const findings = footprintDrift([instance, stale], [instance]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("manifest-declares-unextended");
    expect(findings[0]?.description).toBe("Vec[Symbol(RemovedKey)]");
  });

  it("flags a key the contract extends but the manifest omits", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const undeclared = symbolKey("NewKey");
    const findings = footprintDrift([instance], [instance, undeclared]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("manifest-omits-extended");
    expect(findings[0]?.description).toBe("Vec[Symbol(NewKey)]");
  });

  it("reports both directions at once", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const findings = footprintDrift([instance, symbolKey("Gone")], [instance, symbolKey("Added")]);
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "manifest-declares-unextended",
      "manifest-omits-extended",
    ]);
  });

  it("ignores ordering differences", () => {
    const a = instanceLedgerKey(CONTRACT);
    const b = symbolKey("Balance");
    expect(footprintDrift([a, b], [b, a])).toEqual([]);
  });
});

describe("ttlDrift", () => {
  it("does not report a key that was above threshold and did not move", () => {
    // The regression guard. extend_ttl is conditional: a healthy key is supposed
    // to stay put, and calling that drift would fire on every healthy contract.
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 400_000)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 400_000)];
    expect(ttlDrift(before, after, 100_000)).toEqual([]);
  });

  it("reports a key that was below threshold and did not move", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 50_000)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 50_000)];

    const findings = ttlDrift(before, after, 100_000);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("manifest-declares-unextended");
    expect(findings[0]?.detail).toContain("50000");
  });

  it("does not report a key that was below threshold and did move", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 50_000)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 500_000)];
    expect(ttlDrift(before, after, 100_000)).toEqual([]);
  });

  it("reports an archived key that stayed archived", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 0)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 0)];
    expect(ttlDrift(before, after, 100_000)).toHaveLength(1);
  });

  it("ignores a key missing from the after-reading", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 50_000)];
    expect(ttlDrift(before, [], 100_000)).toEqual([]);
  });

  it("judges each key against the threshold independently", () => {
    const low = symbolKey("Low");
    const high = symbolKey("High");
    const before = [
      reading(low, "Vec[Symbol(Low)]", 10_000),
      reading(high, "Vec[Symbol(High)]", 400_000),
    ];
    const after = [
      reading(low, "Vec[Symbol(Low)]", 10_000),
      reading(high, "Vec[Symbol(High)]", 400_000),
    ];

    const findings = ttlDrift(before, after, 100_000);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toBe("Vec[Symbol(Low)]");
  });
});
