#!/usr/bin/env node
import { Command } from "commander";
import { StrKey } from "@stellar/stellar-sdk";
import { ConfigError } from "./config.js";
import { log } from "./log.js";
import { runScan } from "./commands/scan.js";
import { runExtend } from "./commands/extend.js";
import { runRegistryList } from "./commands/registryList.js";
import { runKeep } from "./commands/keep.js";

/**
 * Reject anything that is not a contract id before it reaches key construction.
 *
 * `Address.fromString` accepts a `G...` account address and yields a valid-looking
 * `ScAddress`, so an account id would build a structurally correct ledger key that
 * simply never resolves. The operator would see an empty or "archived" result
 * instead of being told they passed the wrong kind of address.
 */
function parseContractId(value: string): string {
  if (!StrKey.isValidContract(value)) {
    throw new ConfigError(`not a valid contract id (expected C...), got: ${value}`);
  }
  return value;
}

/**
 * Run one command and turn any failure into an exit code.
 *
 * A config error is the operator's mistake and prints as a plain message. Every
 * other failure logs structured and exits 1.
 */
async function main(): Promise<void> {
  const program = new Command();

  program
    .name("lkeep")
    .description("Off-chain keeper for LedgerKeep. Scan and extend Soroban contract TTL.")
    .version("0.1.0");

  program
    .command("scan")
    .description("Read a contract's TTL. Exits 2 if any key is low or archived.")
    .argument("<contractId>", "contract to scan (C...)", parseContractId)
    .action(async (contractId: string) => {
      process.exitCode = await runScan(contractId);
    });

  program
    .command("extend")
    .description("Extend a contract's TTL. Calls extend_all unless --footprint is given.")
    .argument("<contractId>", "contract to extend (C...)", parseContractId)
    .option("--footprint", "use a raw extendFootprintTtl instead of extend_all", false)
    .option(
      "--key <xdr>",
      "extra ledger key as hex or base64 ScVal; repeatable; only with --footprint",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--durability <kind>", "persistent or temporary; only with --footprint", "persistent")
    .action(
      async (
        contractId: string,
        options: { footprint: boolean; key: string[]; durability: string },
      ) => {
        if (options.durability !== "persistent" && options.durability !== "temporary") {
          throw new Error(
            `--durability must be persistent or temporary, got: ${options.durability}`,
          );
        }
        if (!options.footprint && options.key.length > 0) {
          throw new Error(
            "--key only applies with --footprint. Path A extends the contract's own declared keys.",
          );
        }
        process.exitCode = await runExtend(contractId, {
          footprint: options.footprint,
          key: options.key,
          durability: options.durability as "persistent" | "temporary",
        });
      },
    );

  program
    .command("registry-list")
    .description("Print every contract registered in the registry.")
    .action(async () => {
      process.exitCode = await runRegistryList();
    });

  program
    .command("keep")
    .description("Run the keeper daemon.")
    .action(async () => {
      process.exitCode = await runKeep();
    });

  await program.parseAsync(process.argv);
}

main().catch((cause: unknown) => {
  if (cause instanceof ConfigError) {
    log.error("configuration error", { error: cause.message });
  } else {
    log.error("command failed", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
  process.exitCode = 1;
});
