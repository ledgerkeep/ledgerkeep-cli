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
 * modify entry data. `extendTo` is an absolute target in ledgers from the current
 * one, not a delta.
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

  log.info("simulated footprint extension", {
    keys: keys.length,
    extendTo,
    minResourceFee: sim.minResourceFee,
  });

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`submission rejected: ${JSON.stringify(sent.errorResult ?? sent.status)}`);
  }

  const final = await server.pollTransaction(sent.hash);
  if (final.status !== "SUCCESS") {
    throw new Error(`transaction ${sent.hash} ended ${final.status}`);
  }

  return { hash: sent.hash, minResourceFee: sim.minResourceFee, status: final.status };
}
