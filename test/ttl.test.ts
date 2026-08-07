import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { instanceLedgerKey, contractDataKey, keyId } from "../src/rpc/keys.js";
import { buildReadings, classify, remainingLife } from "../src/rpc/ttl.js";

const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

function symbolKey(name: string): xdr.LedgerKey {
  return contractDataKey(
    CONTRACT,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
    xdr.ContractDataDurability.persistent(),
  );
}

describe("remainingLife", () => {
  it("subtracts the latest ledger from live-until", () => {
    expect(remainingLife(500_000, 100_000)).toBe(400_000);
  });

  it("treats a missing live-until as archived, reporting zero", () => {
    expect(remainingLife(undefined, 100_000)).toBe(0);
  });

  it("clamps a past live-until to zero rather than going negative", () => {
    expect(remainingLife(90_000, 100_000)).toBe(0);
  });

  it("returns zero exactly at the boundary", () => {
    expect(remainingLife(100_000, 100_000)).toBe(0);
  });
});

describe("classify", () => {
  it("is archived at zero remaining", () => {
    expect(classify(0, 100_000)).toBe("archived");
  });

  it("is low below the threshold", () => {
    expect(classify(99_999, 100_000)).toBe("low");
  });

  it("is ok exactly at the threshold", () => {
    expect(classify(100_000, 100_000)).toBe("ok");
  });

  it("is ok above the threshold", () => {
    expect(classify(400_000, 100_000)).toBe("ok");
  });
});

describe("buildReadings", () => {
  it("pairs each requested key with its entry", () => {
    const keys: [xdr.LedgerKey, xdr.LedgerKey] = [
      instanceLedgerKey(CONTRACT),
      symbolKey("Balance"),
    ];
    const entries = [
      { key: keys[0], val: {}, liveUntilLedgerSeq: 600_000 },
      { key: keys[1], val: {}, liveUntilLedgerSeq: 150_000 },
    ];
    const readings = buildReadings(keys, entries, 100_000, 100_000);

    expect(readings).toHaveLength(2);
    expect(readings[0]?.remaining).toBe(500_000);
    expect(readings[0]?.status).toBe("ok");
    expect(readings[0]?.description).toBe("LedgerKeyContractInstance");
    expect(readings[1]?.remaining).toBe(50_000);
    expect(readings[1]?.status).toBe("low");
    expect(readings[1]?.description).toBe("Vec[Symbol(Balance)]");
  });

  it("marks a key the RPC omitted as archived", () => {
    const keys: [xdr.LedgerKey, xdr.LedgerKey] = [
      instanceLedgerKey(CONTRACT),
      symbolKey("Milestones"),
    ];
    const entries = [{ key: keys[0], val: {}, liveUntilLedgerSeq: 600_000 }];
    const readings = buildReadings(keys, entries, 100_000, 100_000);

    expect(readings).toHaveLength(2);
    expect(readings[1]?.status).toBe("archived");
    expect(readings[1]?.liveUntilLedgerSeq).toBeNull();
    expect(readings[1]?.remaining).toBe(0);
  });

  it("preserves the requested key order regardless of response order", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const balance = symbolKey("Balance");
    const keys = [instance, balance];
    const entries = [
      { key: balance, val: {}, liveUntilLedgerSeq: 150_000 },
      { key: instance, val: {}, liveUntilLedgerSeq: 600_000 },
    ];
    const readings = buildReadings(keys, entries, 100_000, 100_000);

    expect(readings[0]?.keyId).toBe(keyId(instance));
    expect(readings[1]?.keyId).toBe(keyId(balance));
  });

  it("reports durability so a scan table can show it", () => {
    const keys = [symbolKey("Balance")];
    const readings = buildReadings(keys, [], 100_000, 100_000);
    expect(readings[0]?.durability).toBe("persistent");
  });
});
