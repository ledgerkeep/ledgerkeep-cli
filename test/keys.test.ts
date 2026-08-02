import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  INSTANCE_KEY_HEX,
  contractDataKey,
  decodeManifestKey,
  describeScVal,
  instanceLedgerKey,
  instanceScVal,
  keyId,
  manifestLedgerKeys,
  parseScValFromHexOrBase64,
} from "../src/rpc/keys.js";

// A real testnet contract ID. Any valid C-address works; this one is only a
// well-formed sample for key construction.
const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

const INSTANCE_HEX = "00000014";
const BALANCE_HEX = "0000001000000001000000010000000f0000000742616c616e636500";
const MILESTONES_HEX = "0000001000000001000000010000000f0000000a4d696c6573746f6e65730000";

describe("instance key", () => {
  it("encodes to the same hex the core registry uses", () => {
    expect(instanceScVal().toXDR("hex")).toBe(INSTANCE_KEY_HEX);
    expect(INSTANCE_KEY_HEX).toBe(INSTANCE_HEX);
  });

  it("round-trips through decodeManifestKey", () => {
    const decoded = decodeManifestKey(Buffer.from(INSTANCE_HEX, "hex"));
    expect(decoded.switch().name).toBe("scvLedgerKeyContractInstance");
    expect(decoded.toXDR("hex")).toBe(INSTANCE_HEX);
  });
});

describe("manifest key decoding", () => {
  it("decodes the escrow Balance key to Vec[Symbol(Balance)]", () => {
    const decoded = decodeManifestKey(Buffer.from(BALANCE_HEX, "hex"));
    expect(describeScVal(decoded)).toBe("Vec[Symbol(Balance)]");
  });

  it("decodes the escrow Milestones key to Vec[Symbol(Milestones)]", () => {
    const decoded = decodeManifestKey(Buffer.from(MILESTONES_HEX, "hex"));
    expect(describeScVal(decoded)).toBe("Vec[Symbol(Milestones)]");
  });

  it("renders the instance key by name", () => {
    expect(describeScVal(instanceScVal())).toBe("LedgerKeyContractInstance");
  });
});

describe("ledger key construction", () => {
  it("round-trips a persistent contract data key", () => {
    const key = contractDataKey(CONTRACT, instanceScVal(), xdr.ContractDataDurability.persistent());
    const reparsed = xdr.LedgerKey.fromXDR(key.toXDR());
    expect(reparsed.toXDR("base64")).toBe(key.toXDR("base64"));
    expect(reparsed.switch().name).toBe("contractData");
    expect(reparsed.contractData().durability().name).toBe("persistent");
  });

  it("builds every manifest key against one contract", () => {
    const keys = manifestLedgerKeys(CONTRACT, [
      Buffer.from(INSTANCE_HEX, "hex"),
      Buffer.from(BALANCE_HEX, "hex"),
      Buffer.from(MILESTONES_HEX, "hex"),
    ]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys.map(keyId)).size).toBe(3);
  });

  it("gives instanceLedgerKey the same id as the manifest instance entry", () => {
    const fromManifest = manifestLedgerKeys(CONTRACT, [Buffer.from(INSTANCE_HEX, "hex")])[0];
    if (fromManifest === undefined) throw new Error("expected one key");
    expect(keyId(fromManifest)).toBe(keyId(instanceLedgerKey(CONTRACT)));
  });

  it("rejects a malformed contract id with a named error", () => {
    expect(() => instanceLedgerKey("not-a-contract")).toThrow(/not a valid contract id/i);
  });
});

describe("parseScValFromHexOrBase64", () => {
  it("accepts hex", () => {
    expect(parseScValFromHexOrBase64(BALANCE_HEX).toXDR("hex")).toBe(BALANCE_HEX);
  });

  it("accepts base64", () => {
    const b64 = Buffer.from(BALANCE_HEX, "hex").toString("base64");
    expect(parseScValFromHexOrBase64(b64).toXDR("hex")).toBe(BALANCE_HEX);
  });

  it("rejects garbage", () => {
    expect(() => parseScValFromHexOrBase64("zzzz")).toThrow(/could not decode/i);
  });
});
