import { rpc } from "@stellar/stellar-sdk";

/** The network a command talks to. */
export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * Build an RPC server client.
 *
 * `allowHttp` is enabled only for loopback URLs so a local quickstart container
 * works without weakening anything pointed at a real network.
 */
export function makeServer(rpcUrl: string): rpc.Server {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`LK_RPC_URL is not a valid URL: ${rpcUrl}`);
  }
  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  return new rpc.Server(rpcUrl, { allowHttp: isLoopback });
}
