import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { log } from "../log.js";

/** What a submitted extension reports back. */
export interface SubmitResult {
  hash: string;
  minResourceFee: string;
  status: string;
}

export interface FootprintParams {
  server: rpc.Server;
  networkPassphrase: string;
  keypair: Keypair;
  keys: xdr.LedgerKey[];
  extendTo: number;
}

/**
 * Build the unsigned Path B transaction.
 *
 * The keys go in the **read-only** footprint: extending time-to-live does not
 * modify entry data. `extendTo` is the minimum TTL, counted in ledgers past the
 * current ledger, that every key in the read-only footprint will have after the
 * operation; entries already above it are skipped.
 */
export function buildFootprintTx(
  account: Account,
  params: Omit<FootprintParams, "server" | "keypair">,
): Transaction {
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: params.networkPassphrase,
  })
    .setSorobanData(new SorobanDataBuilder().setReadOnly(params.keys).build())
    .addOperation(Operation.extendFootprintTtl({ extendTo: params.extendTo }))
    .setTimeout(30)
    .build();
}

/**
 * Extend arbitrary ledger keys directly.
 *
 * This works against any contract, including one that never adopted the
 * LedgerKeep standard. It writes no `lk_state` record and earns no tip. The
 * caller chose this path explicitly; nothing in this program falls back to it.
 */
export async function extendViaFootprint(params: FootprintParams): Promise<SubmitResult> {
  const { server, networkPassphrase, keypair, keys, extendTo } = params;
  if (keys.length === 0) {
    throw new Error("no ledger keys to extend");
  }

  const account = await server.getAccount(keypair.publicKey());
  const tx = buildFootprintTx(account, { networkPassphrase, keys, extendTo });

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }
  // isSimulationError is not enough: a restore-required simulation is a
  // *success* response with an extra `restorePreamble` field, not an error.
  // Submitting it anyway would sign and pay for a transaction the RPC has
  // already told us cannot succeed as written, against archived entries.
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new Error(
      `${keys.length} entr${keys.length === 1 ? "y" : "ies"} require restoring before their TTL can be extended`,
    );
  }

  log.info("simulated footprint extension", {
    keys: keys.length,
    extendTo,
    minResourceFee: sim.minResourceFee,
  });

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") {
    // Only PENDING means the network actually queued the transaction. On
    // TRY_AGAIN_LATER or DUPLICATE, sendTransaction never queued it, so
    // polling would burn the full poll budget against a hash the network
    // does not have and misreport back-pressure as a transaction failure.
    const resultCode = sent.errorResult?.result().switch().name;
    throw new Error(
      resultCode
        ? `submission rejected: ${sent.status} (${resultCode})`
        : `submission rejected: ${sent.status}`,
    );
  }

  const final = await server.pollTransaction(sent.hash);
  if (final.status !== "SUCCESS") {
    // JSON.stringify on resultXdr would emit js-xdr internals, not a code.
    const resultCode =
      final.status === "FAILED" ? final.resultXdr.result().switch().name : undefined;
    throw new Error(
      resultCode
        ? `transaction ${sent.hash} ended ${final.status} (${resultCode})`
        : `transaction ${sent.hash} ended ${final.status}`,
    );
  }

  return { hash: sent.hash, minResourceFee: sim.minResourceFee, status: final.status };
}
