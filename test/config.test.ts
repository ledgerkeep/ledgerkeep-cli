import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { ConfigError, loadConfig, loadKeypair } from "../src/config.js";

/** A structurally valid contract id, built rather than pasted. */
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

/** Written outside the repository so no key material can ever be staged. */
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "lk-config-test-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function completeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    LK_RPC_URL: "https://soroban-testnet.stellar.org",
    LK_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    LK_REGISTRY_ID: CONTRACT_ID,
    LK_KEEPER_KEY: "/nonexistent/keeper.key",
    LK_THRESHOLD: "100000",
    LK_EXTEND_TO: "500000",
    LK_SCAN_INTERVAL_MS: "60000",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("parses a complete environment into integers", () => {
    const config = loadConfig(completeEnv());
    expect(config.registryId).toBe(CONTRACT_ID);
    expect(config.threshold).toBe(100_000);
    expect(config.extendTo).toBe(500_000);
    expect(config.scanIntervalMs).toBe(60_000);
  });

  it("does not open the keeper key file", () => {
    // Read-only commands run on machines that hold no key. Loading config must
    // not touch the path, so an unreadable path is not an error here.
    const env = completeEnv({ LK_KEEPER_KEY: "/nonexistent/nope.key" });
    expect(() => loadConfig(env)).not.toThrow();
    expect(loadConfig(env).keeperKeyPath).toBe("/nonexistent/nope.key");
  });

  it("names the missing variable", () => {
    const env = completeEnv();
    delete env.LK_RPC_URL;
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/LK_RPC_URL is not set/);
  });

  it("treats a blank variable as missing", () => {
    expect(() => loadConfig(completeEnv({ LK_NETWORK_PASSPHRASE: "   " }))).toThrow(
      /LK_NETWORK_PASSPHRASE is not set/,
    );
  });

  it("rejects a threshold at or above the extend target", () => {
    // Extending to a target at or below the trigger would re-extend every scan.
    expect(() => loadConfig(completeEnv({ LK_THRESHOLD: "500000" }))).toThrow(
      /must be below LK_EXTEND_TO/,
    );
    expect(() => loadConfig(completeEnv({ LK_THRESHOLD: "600000" }))).toThrow(
      /must be below LK_EXTEND_TO/,
    );
  });

  it("rejects a non-integer ledger count", () => {
    expect(() => loadConfig(completeEnv({ LK_THRESHOLD: "1e5" }))).toThrow(/whole number/);
    expect(() => loadConfig(completeEnv({ LK_THRESHOLD: "100.5" }))).toThrow(/whole number/);
    expect(() => loadConfig(completeEnv({ LK_THRESHOLD: "-1" }))).toThrow(/whole number/);
    expect(() => loadConfig(completeEnv({ LK_THRESHOLD: "0" }))).toThrow(/positive whole number/);
  });

  it("rejects an account address where a contract id is required", () => {
    // Address.fromString accepts G... happily, so this must be caught here.
    const account = Keypair.random().publicKey();
    expect(() => loadConfig(completeEnv({ LK_REGISTRY_ID: account }))).toThrow(
      /not a valid contract id/,
    );
  });

  it("rejects a malformed RPC URL", () => {
    expect(() => loadConfig(completeEnv({ LK_RPC_URL: "not a url" }))).toThrow(/not a valid URL/);
  });

  it("rejects a URL whose scheme the RPC client cannot speak", () => {
    // Parses fine, but nothing downstream could ever use it.
    expect(() => loadConfig(completeEnv({ LK_RPC_URL: "file:///etc/passwd" }))).toThrow(
      /must be an http or https URL/,
    );
    expect(() => loadConfig(completeEnv({ LK_RPC_URL: "ftp://example.com" }))).toThrow(
      /must be an http or https URL/,
    );
  });

  it("accepts a loopback http URL for a local quickstart", () => {
    const config = loadConfig(completeEnv({ LK_RPC_URL: "http://localhost:8000/soroban/rpc" }));
    expect(config.rpcUrl).toBe("http://localhost:8000/soroban/rpc");
  });
});

describe("loadKeypair", () => {
  it("loads a seed from the file named by the path", () => {
    const keypair = Keypair.random();
    const path = join(scratch, "good.key");
    writeFileSync(path, `${keypair.secret()}\n`, { mode: 0o600 });

    const loaded = loadKeypair(loadConfig(completeEnv({ LK_KEEPER_KEY: path })));
    expect(loaded.publicKey()).toBe(keypair.publicKey());
  });

  it("names the path but not the contents when the seed is malformed", () => {
    // The whole point: a message that echoed the file would leak the key into logs.
    const secretish = "SBSECRETVALUETHATMUSTNEVERAPPEARINANYMESSAGE1234567890";
    const path = join(scratch, "bad.key");
    writeFileSync(path, secretish, { mode: 0o600 });

    let message = "";
    try {
      loadKeypair(loadConfig(completeEnv({ LK_KEEPER_KEY: path })));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(path);
    expect(message).not.toContain(secretish);
  });

  it("does not echo a real seed when the file holds extra content", () => {
    const keypair = Keypair.random();
    const path = join(scratch, "extra.key");
    writeFileSync(path, `${keypair.secret()} trailing junk`, { mode: 0o600 });

    let message = "";
    try {
      loadKeypair(loadConfig(completeEnv({ LK_KEEPER_KEY: path })));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(path);
    expect(message).not.toContain(keypair.secret());
  });

  it("names the path when the file is missing", () => {
    const path = join(scratch, "absent.key");
    expect(() => loadKeypair(loadConfig(completeEnv({ LK_KEEPER_KEY: path })))).toThrow(
      new RegExp(`could not read the keeper key file at ${path}`),
    );
  });
});
