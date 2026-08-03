import { describe, expect, it } from "vitest";
import { Account, Networks, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { contractDataKey, instanceLedgerKey, keyId } from "../src/rpc/keys.js";
import { buildFootprintTx } from "../src/ops/extendViaFootprint.js";
import { footprintKeysForContract } from "../src/ops/extendViaContract.js";

const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const OTHER = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

function symbolKey(contract: string, name: string): xdr.LedgerKey {
  return contractDataKey(
    contract,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
    xdr.ContractDataDurability.persistent(),
  );
}

describe("buildFootprintTx", () => {
  it("puts the keys in the read-only footprint and uses extendTo", () => {
    const keys = [instanceLedgerKey(CONTRACT), symbolKey(CONTRACT, "Balance")];
    const tx = buildFootprintTx(new Account(SOURCE, "0"), {
      networkPassphrase: Networks.TESTNET,
      keys,
      extendTo: 500_000,
    });

    const data = new SorobanDataBuilder(tx.toEnvelope().v1().tx().ext().sorobanData());
    expect(data.getReadOnly().map(keyId)).toEqual(keys.map(keyId));
    expect(data.getReadWrite()).toHaveLength(0);

    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0];
    if (op === undefined) throw new Error("expected one operation");
    expect(op.type).toBe("extendFootprintTtl");
  });

  it("carries the extendTo value onto the operation", () => {
    const tx = buildFootprintTx(new Account(SOURCE, "0"), {
      networkPassphrase: Networks.TESTNET,
      keys: [instanceLedgerKey(CONTRACT)],
      extendTo: 123_456,
    });
    const op = tx.operations[0];
    if (op === undefined || op.type !== "extendFootprintTtl") {
      throw new Error("expected an extendFootprintTtl operation");
    }
    expect(op.extendTo).toBe(123_456);
  });
});

describe("footprintKeysForContract", () => {
  it("unions read-only and read-write", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const balance = symbolKey(CONTRACT, "Balance");
    const data = new SorobanDataBuilder().setReadOnly([balance]).setReadWrite([instance]).build();

    const found = footprintKeysForContract(new SorobanDataBuilder(data), CONTRACT);
    expect(new Set(found.map(keyId))).toEqual(new Set([keyId(instance), keyId(balance)]));
  });

  it("drops keys belonging to another contract", () => {
    const mine = instanceLedgerKey(CONTRACT);
    const theirs = symbolKey(OTHER, "Balance");
    const data = new SorobanDataBuilder().setReadOnly([mine, theirs]).build();

    const found = footprintKeysForContract(new SorobanDataBuilder(data), CONTRACT);
    expect(found.map(keyId)).toEqual([keyId(mine)]);
  });

  it("deduplicates a key present in both halves", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const data = new SorobanDataBuilder().setReadOnly([instance]).setReadWrite([instance]).build();

    const found = footprintKeysForContract(new SorobanDataBuilder(data), CONTRACT);
    expect(found).toHaveLength(1);
  });
});
