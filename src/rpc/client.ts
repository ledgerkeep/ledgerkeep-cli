import { rpc } from "@stellar/stellar-sdk";

/**
 * Hostnames `URL` reports for the loopback interface. `URL` keeps the brackets
 * around an IPv6 host, so `[::1]` is the literal value to match — not `::1`.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Build an RPC server client.
 *
 * `allowHttp` is enabled only for plaintext loopback URLs, so a local quickstart
 * container works without weakening anything pointed at a real network.
 */
export function makeServer(rpcUrl: string): rpc.Server {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`LK_RPC_URL is not a valid URL: ${rpcUrl}`);
  }
  const allowHttp = parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname);
  return new rpc.Server(rpcUrl, { allowHttp });
}
