import { readFileSync } from "node:fs";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

/** Everything a command needs from the environment. */
export interface Config {
  rpcUrl: string;
  networkPassphrase: string;
  registryId: string;
  keeperKeyPath: string;
  threshold: number;
  extendTo: number;
  scanIntervalMs: number;
}

/** Thrown for any invalid or missing environment variable. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(`${name} is not set. Copy .env.example and fill it in.`);
  }
  return raw.trim();
}

function requirePositiveInt(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requireString(env, name);
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be a whole number of ledgers, got: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive whole number, got: ${raw}`);
  }
  return value;
}

function requireContractId(env: NodeJS.ProcessEnv, name: string): string {
  const raw = requireString(env, name);
  if (!StrKey.isValidContract(raw)) {
    throw new ConfigError(`${name} is not a valid contract id (expected C...), got: ${raw}`);
  }
  return raw;
}

function requireUrl(env: NodeJS.ProcessEnv, name: string): string {
  const raw = requireString(env, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL, got: ${raw}`);
  }
  // The only consumer is the RPC client, which speaks http(s). Rejecting other
  // schemes here gives a clear message instead of an SDK failure further in.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${name} must be an http or https URL, got: ${raw}`);
  }
  return raw;
}

/**
 * Load and validate the environment.
 *
 * Every variable is validated here so no command runs against a half-checked
 * config. The keeper key file is deliberately not opened — read-only commands
 * must work on a machine that holds no key at all.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const threshold = requirePositiveInt(env, "LK_THRESHOLD");
  const extendTo = requirePositiveInt(env, "LK_EXTEND_TO");
  if (threshold >= extendTo) {
    throw new ConfigError(
      `LK_THRESHOLD (${threshold}) must be below LK_EXTEND_TO (${extendTo}). ` +
        "Extending to a target at or below the trigger point would re-extend every scan.",
    );
  }

  return {
    rpcUrl: requireUrl(env, "LK_RPC_URL"),
    networkPassphrase: requireString(env, "LK_NETWORK_PASSPHRASE"),
    registryId: requireContractId(env, "LK_REGISTRY_ID"),
    keeperKeyPath: requireString(env, "LK_KEEPER_KEY"),
    threshold,
    extendTo,
    scanIntervalMs: requirePositiveInt(env, "LK_SCAN_INTERVAL_MS"),
  };
}

/**
 * Load the keeper's signing key from the file named by `LK_KEEPER_KEY`.
 *
 * The file holds one secret seed and nothing else. The value is never returned,
 * logged, or stored anywhere but the returned `Keypair`. Error messages name the
 * path, never the contents — a malformed-secret message that echoed the value
 * would leak it into logs.
 */
export function loadKeypair(config: Config): Keypair {
  let contents: string;
  try {
    contents = readFileSync(config.keeperKeyPath, "utf8");
  } catch {
    throw new ConfigError(
      `could not read the keeper key file at ${config.keeperKeyPath}. ` +
        "LK_KEEPER_KEY must be a path to a file holding one secret seed.",
    );
  }

  const secret = contents.trim();
  if (!StrKey.isValidEd25519SecretSeed(secret)) {
    throw new ConfigError(
      `the file at ${config.keeperKeyPath} does not contain a valid secret seed. ` +
        "Expected one S... line and nothing else.",
    );
  }

  return Keypair.fromSecret(secret);
}
