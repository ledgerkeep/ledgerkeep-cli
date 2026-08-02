import { Address, xdr } from "@stellar/stellar-sdk";

/**
 * `ScVal::LedgerKeyContractInstance`, XDR-encoded.
 *
 * This is the key of a contract's instance entry, and the same literal the core
 * registry's constructor publishes in its own manifest.
 */
export const INSTANCE_KEY_HEX = "00000014";

/** The `ScVal` naming a contract's instance entry. */
export function instanceScVal(): xdr.ScVal {
  return xdr.ScVal.scvLedgerKeyContractInstance();
}

/**
 * Decode one raw manifest entry.
 *
 * A registry manifest holds XDR-encoded `ScVal` as `Bytes`, never decoded
 * on-chain. This is where it becomes a value we can build a ledger key from.
 */
export function decodeManifestKey(raw: Buffer): xdr.ScVal {
  try {
    return xdr.ScVal.fromXDR(raw);
  } catch (cause) {
    const hex = raw.toString("hex");
    throw new Error(`manifest entry is not a valid ScVal: ${hex}`, { cause });
  }
}

/** Accept a key supplied on the command line as either hex or base64. */
export function parseScValFromHexOrBase64(input: string): xdr.ScVal {
  const trimmed = input.trim();
  const encodings: Array<"hex" | "base64"> = /^[0-9a-fA-F]+$/.test(trimmed)
    ? ["hex", "base64"]
    : ["base64", "hex"];
  for (const encoding of encodings) {
    try {
      return xdr.ScVal.fromXDR(Buffer.from(trimmed, encoding));
    } catch {
      continue;
    }
  }
  throw new Error(`could not decode --key as hex or base64 ScVal: ${input}`);
}

function toScAddress(contractId: string): xdr.ScAddress {
  try {
    return Address.fromString(contractId).toScAddress();
  } catch (cause) {
    throw new Error(`not a valid contract id: ${contractId}`, { cause });
  }
}

/** Build a `ContractData` ledger key. Used for both reading TTL and Path B. */
export function contractDataKey(
  contractId: string,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: toScAddress(contractId),
      key,
      durability,
    }),
  );
}

/**
 * The ledger key of a contract's instance entry.
 *
 * Instance entries are `ContractData` with persistent durability, which is why
 * this is not a separate durability case.
 */
export function instanceLedgerKey(contractId: string): xdr.LedgerKey {
  return contractDataKey(contractId, instanceScVal(), xdr.ContractDataDurability.persistent());
}

/**
 * Build every ledger key a manifest declares.
 *
 * Durability is always persistent. `impl_maintainable!` touches only
 * `instance()` and `persistent()` storage, and instance entries are themselves
 * persistent `ContractData`, so no manifest key can be temporary.
 */
export function manifestLedgerKeys(contractId: string, keysXdr: Buffer[]): xdr.LedgerKey[] {
  return keysXdr.map((raw) =>
    contractDataKey(contractId, decodeManifestKey(raw), xdr.ContractDataDurability.persistent()),
  );
}

/** A stable identity for a ledger key, for set membership and map lookups. */
export function keyId(key: xdr.LedgerKey): string {
  return key.toXDR("base64");
}

/**
 * Render an `ScVal` for a human.
 *
 * The registry stores no per-key labels, so a decoded rendering of the key
 * itself is the most descriptive thing a scan can print.
 */
export function describeScVal(value: xdr.ScVal): string {
  switch (value.switch().name) {
    case "scvLedgerKeyContractInstance":
      return "LedgerKeyContractInstance";
    case "scvSymbol":
      return `Symbol(${value.sym().toString()})`;
    case "scvString":
      return `String(${value.str().toString()})`;
    case "scvU32":
      return `U32(${value.u32()})`;
    case "scvI32":
      return `I32(${value.i32()})`;
    case "scvU64":
      return `U64(${value.u64().toString()})`;
    case "scvI64":
      return `I64(${value.i64().toString()})`;
    case "scvBool":
      return `Bool(${value.b()})`;
    case "scvAddress":
      return `Address(${Address.fromScAddress(value.address()).toString()})`;
    case "scvVec": {
      const items = value.vec() ?? [];
      return `Vec[${items.map(describeScVal).join(", ")}]`;
    }
    case "scvMap": {
      const entries = value.map() ?? [];
      return `Map{${entries
        .map((e) => `${describeScVal(e.key())}: ${describeScVal(e.val())}`)
        .join(", ")}}`;
    }
    default:
      return `${value.switch().name}(${value.toXDR("base64")})`;
  }
}
