import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { log } from "../log.js";
import type { SubmitResult } from "./extendViaFootprint.js";

/** The SDK's stand-in source account for simulation-only calls. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface ContractExtendResult extends SubmitResult {
  footprint: xdr.LedgerKey[];
}

export interface ExtendAllParams {
  server: rpc.Server;
  networkPassphrase: string;
  contractId: string;
  keeper: string;
}

/**
 * Every `ContractData` key in a simulation footprint belonging to one contract.
 *
 * Read-only and read-write are unioned. A time-to-live extension may be recorded
 * in either, and which one is not worth depending on — what matters is the set of
 * keys the compiled contract touched.
 */
export function footprintKeysForContract(
  data: SorobanDataBuilder,
  contractId: string,
): xdr.LedgerKey[] {
  const target = Address.fromString(contractId).toScAddress().toXDR("base64");
  const all = [...data.getReadOnly(), ...data.getReadWrite()];
  const seen = new Set<string>();
  const out: xdr.LedgerKey[] = [];

  for (const key of all) {
    if (key.switch().name !== "contractData") continue;
    if (key.contractData().contract().toXDR("base64") !== target) continue;
    const id = key.toXDR("base64");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

function buildExtendAllTx(
  account: Account,
  networkPassphrase: string,
  contractId: string,
  keeper: string,
): Transaction {
  const contract = new Contract(contractId);
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call("extend_all", Address.fromString(keeper).toScVal()))
    .setTimeout(30)
    .build();
}

/**
 * Simulate `extend_all` without submitting.
 *
 * Costs nothing and signs nothing. The returned footprint is the set of ledger
 * keys the compiled contract actually touches, which is what drift detection
 * compares against the published manifest.
 */
export async function simulateExtendAll(
  params: ExtendAllParams,
): Promise<{ footprint: xdr.LedgerKey[]; minResourceFee: string }> {
  const { server, networkPassphrase, contractId, keeper } = params;
  const account = new Account(NULL_ACCOUNT, "0");
  const tx = buildExtendAllTx(account, networkPassphrase, contractId, keeper);

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation of extend_all failed: ${sim.error}`);
  }

  return {
    footprint: footprintKeysForContract(sim.transactionData, contractId),
    minResourceFee: sim.minResourceFee,
  };
}

/**
 * Call a contract's own permissionless `extend_all`.
 *
 * This is the path that produces a claimable maintenance record: the contract
 * extends its declared keys and writes `lk_state`, which a rent vault reads when
 * deciding whether the keeper earned a tip. Path B produces no such record, and
 * this function never falls back to it.
 *
 * `extend_all` calls `keeper.require_auth()`. The keeper is the transaction
 * source account here, so source-account auth satisfies that with the single
 * signature applied below.
 */
export async function extendViaContract(
  params: Omit<ExtendAllParams, "keeper"> & { keypair: Keypair },
): Promise<ContractExtendResult> {
  const { server, networkPassphrase, contractId, keypair } = params;
  const keeper = keypair.publicKey();

  const account = await server.getAccount(keeper);
  const tx = buildExtendAllTx(account, networkPassphrase, contractId, keeper);

  // One simulation, not `prepareTransaction` plus a separate `simulateTransaction`.
  // `assembleTransaction` does what `prepareTransaction` does with a simulation we
  // already hold, and the footprint below comes out of that same response.
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation of extend_all failed: ${sim.error}`);
  }
  // Deliberately no `isSimulationRestore` guard, unlike Path B. Since Protocol
  // 23 an archived persistent entry is restored automatically when it appears
  // in the footprint of an InvokeHostFunctionOp, which is what this is. Path B
  // needs the guard because ExtendFootprintTTLOp cannot restore anything.

  log.info("simulated extend_all", {
    contract: contractId,
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
    // JSON.stringify on errorResult would emit js-xdr internals, not a code.
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

  return {
    hash: sent.hash,
    minResourceFee: sim.minResourceFee,
    status: final.status,
    footprint: footprintKeysForContract(sim.transactionData, contractId),
  };
}
