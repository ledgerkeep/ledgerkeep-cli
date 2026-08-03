import { describe, expect, it } from "vitest";
import { contract as contractSpec } from "@stellar/stellar-sdk";
import { decodeEntry, unwrapPage } from "../src/registry/discover.js";
import { describeScVal, decodeManifestKey, manifestLedgerKeys } from "../src/rpc/keys.js";

/** The long_escrow example, as deployed to testnet by core's `init_testnet.sh`. */
const ESCROW = "CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6";

const INSTANCE_HEX = "00000014";
const BALANCE_HEX = "0000001000000001000000010000000f0000000742616c616e636500";
const MILESTONES_HEX = "0000001000000001000000010000000f0000000a4d696c6573746f6e65730000";

function fixture(): Record<string, unknown> {
  return {
    contract: ESCROW,
    keys_xdr: [
      Buffer.from(INSTANCE_HEX, "hex"),
      Buffer.from(BALANCE_HEX, "hex"),
      Buffer.from(MILESTONES_HEX, "hex"),
    ],
    threshold: 100_000,
    extend_to: 500_000,
    registered: 1_234,
    updated: 5_678,
  };
}

describe("decodeEntry", () => {
  it("maps the on-chain snake_case fields to camelCase", () => {
    const entry = decodeEntry(fixture());
    expect(entry.contract).toBe(ESCROW);
    expect(entry.threshold).toBe(100_000);
    expect(entry.extendTo).toBe(500_000);
    expect(entry.registered).toBe(1_234);
    expect(entry.updated).toBe(5_678);
    expect(entry.keysXdr).toHaveLength(3);
  });

  it("produces keys that decode to the escrow's real manifest", () => {
    const entry = decodeEntry(fixture());
    const described = entry.keysXdr.map((raw) => describeScVal(decodeManifestKey(raw)));
    expect(described).toEqual([
      "LedgerKeyContractInstance",
      "Vec[Symbol(Balance)]",
      "Vec[Symbol(Milestones)]",
    ]);
  });

  it("produces keys that build into three distinct ledger keys", () => {
    const entry = decodeEntry(fixture());
    const keys = manifestLedgerKeys(entry.contract, entry.keysXdr);
    expect(keys).toHaveLength(3);
  });

  it("accepts a Uint8Array where the SDK did not hand back a Buffer", () => {
    const raw = fixture();
    raw.keys_xdr = [new Uint8Array(Buffer.from(INSTANCE_HEX, "hex"))];
    const entry = decodeEntry(raw);
    expect(describeScVal(decodeManifestKey(entry.keysXdr[0] as Buffer))).toBe(
      "LedgerKeyContractInstance",
    );
  });

  it("rejects an entry missing keys_xdr", () => {
    const raw = fixture();
    delete raw.keys_xdr;
    expect(() => decodeEntry(raw)).toThrow(/keys_xdr/);
  });

  it("rejects a non-object", () => {
    expect(() => decodeEntry("nope")).toThrow(/registry entry/i);
  });
});

describe("unwrapPage", () => {
  it("unwraps the Ok the registry actually returns", () => {
    // The live registry returns a Rust Result, which the SDK hands back as Ok,
    // not as a bare array. Checking Array.isArray on the raw value rejected
    // every real page.
    const entries = [fixture()];
    expect(unwrapPage(new contractSpec.Ok(entries), 0)).toEqual(entries);
  });

  it("treats an exhausted page as empty rather than an error", () => {
    expect(unwrapPage(new contractSpec.Ok([]), 999)).toEqual([]);
  });

  it("throws on an Err, naming the start offset", () => {
    expect(() => unwrapPage(new contractSpec.Err("LimitTooLarge"), 50)).toThrow(/start=50/);
  });

  it("throws when the payload is not a list", () => {
    expect(() => unwrapPage(new contractSpec.Ok("nope"), 0)).toThrow(/did not return a list/);
    expect(() => unwrapPage(42, 0)).toThrow(/did not return a list/);
  });
});
