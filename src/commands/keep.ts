import { loadConfig, loadKeypair } from "../config.js";
import { log } from "../log.js";
import { makeServer } from "../rpc/client.js";
import { runLoop, type KeeperContext } from "../keeper/loop.js";

/**
 * Run the keeper daemon until interrupted.
 *
 * SIGINT and SIGTERM abort the loop so an in-flight tick finishes rather than
 * being killed mid-transaction.
 */
export async function runKeep(): Promise<number> {
  const config = loadConfig();
  const server = makeServer(config.rpcUrl);
  const keypair = loadKeypair(config);

  const ctx: KeeperContext = { config, server, keypair };
  const controller = new AbortController();

  const stop = (signalName: string) => {
    log.info("stopping", { signal: signalName });
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  log.info("daemon started", {
    registry: config.registryId,
    keeper: keypair.publicKey(),
    intervalMs: config.scanIntervalMs,
    threshold: config.threshold,
    extendTo: config.extendTo,
  });

  await runLoop(ctx, controller.signal);
  return 0;
}
