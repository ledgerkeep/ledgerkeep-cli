import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Keypair, Networks, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { contractDataKey, instanceLedgerKey, keyId } from "../src/rpc/keys.js";
import type { TtlReading } from "../src/rpc/ttl.js";
import type { Config } from "../src/config.js";
import {
  FutilityTracker,
  MAX_BACKOFF_TICKS,
  backoffTicks,
  obligatedReadings,
} from "../src/keeper/futility.js";
import { maintainContract, type KeeperContext } from "../src/keeper/loop.js";
import type { ManifestEntry } from "../src/registry/discover.js";

const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const THRESHOLD = 100_000;
const LATEST_LEDGER = 1_000;

function symbolScVal(name: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
}

function symbolKey(name: string): xdr.LedgerKey {
  return contractDataKey(CONTRACT, symbolScVal(name), xdr.ContractDataDurability.persistent());
}

function reading(key: xdr.LedgerKey, remaining: number): TtlReading {
  return {
    key,
    keyId: keyId(key),
    description: "test key",
    durability: "persistent",
    liveUntilLedgerSeq: remaining > 0 ? remaining + LATEST_LEDGER : null,
    remaining,
    status: remaining <= 0 ? "archived" : remaining < THRESHOLD ? "low" : "ok",
  };
}

describe("obligatedReadings", () => {
  it("keeps only readings for keys the contract's footprint touches", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const balance = symbolKey("Balance");
    const stale = symbolKey("RemovedKey");

    const kept = obligatedReadings(
      [reading(instance, 10), reading(balance, 20), reading(stale, 30)],
      [instance, balance],
    );

    expect(kept.map((r) => r.keyId)).toEqual([keyId(instance), keyId(balance)]);
  });

  it("is empty when the footprint shares no key with the manifest", () => {
    expect(
      obligatedReadings([reading(symbolKey("Stale"), 5)], [instanceLedgerKey(CONTRACT)]),
    ).toEqual([]);
  });

  it("is empty when the simulation returned no footprint keys at all", () => {
    expect(obligatedReadings([reading(symbolKey("Balance"), 5)], [])).toEqual([]);
  });
});

describe("backoffTicks", () => {
  it("doubles with each consecutive futile extension", () => {
    expect([1, 2, 3, 4, 5].map(backoffTicks)).toEqual([1, 2, 4, 8, 16]);
  });

  it("caps so a repaired manifest is noticed within a shift", () => {
    expect(backoffTicks(7)).toBe(MAX_BACKOFF_TICKS);
    expect(backoffTicks(50)).toBe(MAX_BACKOFF_TICKS);
  });

  it("skips nothing before the first futile extension", () => {
    expect(backoffTicks(0)).toBe(0);
  });
});

describe("FutilityTracker", () => {
  it("does not skip a contract it has never seen", () => {
    expect(new FutilityTracker().consumeBackoff(CONTRACT).skip).toBe(false);
  });

  it("skips exactly the number of ticks the window opened for, then retries", () => {
    const tracker = new FutilityTracker();
    tracker.recordFutile(CONTRACT); // window of 1
    tracker.recordProductive(CONTRACT);
    tracker.recordFutile(CONTRACT);
    tracker.recordFutile(CONTRACT); // second in a row: window of 2

    expect(tracker.consumeBackoff(CONTRACT)).toEqual({
      skip: true,
      ticksRemaining: 1,
      consecutiveFutile: 2,
    });
    expect(tracker.consumeBackoff(CONTRACT).skip).toBe(true);
    expect(tracker.consumeBackoff(CONTRACT).skip).toBe(false);
  });

  it("clears the window as soon as an extension achieves something", () => {
    const tracker = new FutilityTracker();
    tracker.recordFutile(CONTRACT);
    tracker.recordFutile(CONTRACT);
    tracker.recordProductive(CONTRACT);

    // Not merely un-skipped: the streak resets too, so the next failure starts
    // at a one-tick window rather than resuming a long one.
    expect(tracker.recordFutile(CONTRACT)).toEqual({ consecutiveFutile: 1, ticksToSkip: 1 });
  });

  it("tracks contracts independently", () => {
    const tracker = new FutilityTracker();
    tracker.recordFutile(CONTRACT);
    expect(tracker.consumeBackoff(CONTRACT).skip).toBe(true);
    expect(
      tracker.consumeBackoff("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC").skip,
    ).toBe(false);
  });
});

/**
 * A server that answers the two read calls `maintainContract` makes before it
 * decides to spend, and fails loudly on any call that would sign or submit.
 *
 * `getAccount` is the first thing `extendViaContract` touches, so recording it is
 * enough to tell "decided to extend" from "decided to skip".
 */
function fakeServer(options: {
  entries: { key: xdr.LedgerKey; liveUntilLedgerSeq: number }[];
  footprint: xdr.LedgerKey[];
  onGetAccount: () => void;
}): rpc.Server {
  return {
    getLedgerEntries: (...keys: xdr.LedgerKey[]) => {
      const requested = new Set(keys.map(keyId));
      return Promise.resolve({
        entries: options.entries.filter((entry) => requested.has(keyId(entry.key))),
        latestLedger: LATEST_LEDGER,
      });
    },
    simulateTransaction: () =>
      Promise.resolve({
        transactionData: new SorobanDataBuilder().setReadWrite(options.footprint),
        minResourceFee: "100",
      }),
    getAccount: () => {
      options.onGetAccount();
      return Promise.reject(new Error("stopped before signing"));
    },
    sendTransaction: () => Promise.reject(new Error("sendTransaction must not be reached")),
    pollTransaction: () => Promise.reject(new Error("pollTransaction must not be reached")),
  } as unknown as rpc.Server;
}

const CONFIG: Config = {
  rpcUrl: "https://example.invalid",
  networkPassphrase: Networks.TESTNET,
  registryId: CONTRACT,
  keeperKeyPath: "/dev/null",
  threshold: THRESHOLD,
  extendTo: 500_000,
  scanIntervalMs: 60_000,
};

function manifestEntry(keys: xdr.ScVal[]): ManifestEntry {
  return {
    contract: CONTRACT,
    keysXdr: keys.map((key) => Buffer.from(key.toXDR())),
    threshold: 0,
    extendTo: 0,
    registered: 0,
    updated: 0,
  };
}

describe("maintainContract futility gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not spend when no key below threshold is in the extend_all footprint", async () => {
    // `log.warn` writes to stdout, not stderr; only `log.error` uses console.error.
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    let signingReached = false;

    // The manifest declares Balance and it is nearly dead, but the compiled
    // contract only ever touches its instance entry. Extending cannot help.
    const stale = symbolKey("Balance");
    const ctx: KeeperContext = {
      config: CONFIG,
      server: fakeServer({
        entries: [{ key: stale, liveUntilLedgerSeq: LATEST_LEDGER + 10 }],
        footprint: [instanceLedgerKey(CONTRACT)],
        onGetAccount: () => {
          signingReached = true;
        },
      }),
      keypair: Keypair.random(),
      signal: new AbortController().signal,
      futility: new FutilityTracker(),
    };

    await maintainContract(ctx, manifestEntry([symbolScVal("Balance")]));

    expect(signingReached).toBe(false);
    const lines = out.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("skipping futile extension"))).toBe(true);
  });

  it("still spends when a key below threshold is in the footprint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let signingReached = false;

    const balance = symbolKey("Balance");
    const ctx: KeeperContext = {
      config: CONFIG,
      server: fakeServer({
        entries: [{ key: balance, liveUntilLedgerSeq: LATEST_LEDGER + 10 }],
        footprint: [balance],
        onGetAccount: () => {
          signingReached = true;
        },
      }),
      keypair: Keypair.random(),
      signal: new AbortController().signal,
      futility: new FutilityTracker(),
    };

    await maintainContract(ctx, manifestEntry([symbolScVal("Balance")]));

    expect(signingReached).toBe(true);
  });

  it("opens a backoff window when a landed extension moves nothing", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    // The key is in the footprint, so the gate above lets this through and the
    // transaction lands — but the contract reads the key without extending it,
    // so its remaining life is identical afterwards. Only the outcome reveals it.
    const balance = symbolKey("Balance");
    const keypair = Keypair.random();
    const futility = new FutilityTracker();
    const server = {
      getLedgerEntries: () =>
        Promise.resolve({
          entries: [{ key: balance, liveUntilLedgerSeq: LATEST_LEDGER + 10 }],
          latestLedger: LATEST_LEDGER,
        }),
      // `_parsed` marks this as an already-decoded response. Without it
      // `assembleTransaction` runs the raw parser over it and rebuilds the
      // already-built `SorobanDataBuilder` from itself. `result` must be present
      // for the same reason: assembleTransaction reads `result.auth` unguarded.
      simulateTransaction: () =>
        Promise.resolve({
          _parsed: true,
          transactionData: new SorobanDataBuilder().setReadWrite([balance]),
          minResourceFee: "100",
          result: { auth: [], retval: xdr.ScVal.scvVoid() },
        }),
      getAccount: () => Promise.resolve(new Account(keypair.publicKey(), "0")),
      sendTransaction: () => Promise.resolve({ status: "PENDING", hash: "deadbeef" }),
      pollTransaction: () => Promise.resolve({ status: "SUCCESS" }),
    } as unknown as rpc.Server;

    await maintainContract(
      {
        config: CONFIG,
        server,
        keypair,
        signal: new AbortController().signal,
        futility,
      },
      manifestEntry([symbolScVal("Balance")]),
    );

    const lines = out.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("extension changed nothing"))).toBe(true);
    expect(futility.consumeBackoff(CONTRACT).skip).toBe(true);
  });

  it("makes no RPC call at all for a contract inside a backoff window", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let read = false;
    const server = {
      getLedgerEntries: () => {
        read = true;
        return Promise.reject(new Error("getLedgerEntries must not be reached"));
      },
    } as unknown as rpc.Server;

    const futility = new FutilityTracker();
    futility.recordFutile(CONTRACT);

    await maintainContract(
      {
        config: CONFIG,
        server,
        keypair: Keypair.random(),
        signal: new AbortController().signal,
        futility,
      },
      manifestEntry([symbolScVal("Balance")]),
    );

    expect(read).toBe(false);
  });
});
