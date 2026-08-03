import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { log } from "../src/log.js";

function captureOut(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return { lines, restore: () => spy.mockRestore() };
}

function captureErr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: string) => {
    lines.push(line);
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Parse the single line a capture collected, failing loudly if there isn't exactly one. */
function soleRecord(lines: string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) throw new Error("no line captured");
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) throw new Error("line is not an object");
  return parsed as Record<string, unknown>;
}

describe("log", () => {
  it("writes one JSON object per line with ts, level and msg", () => {
    const out = captureOut();
    log.info("scanning", { contract: "CABC", keys: 3 });
    const record = soleRecord(out.lines);
    out.restore();

    expect(record.level).toBe("info");
    expect(record.msg).toBe("scanning");
    expect(record.contract).toBe("CABC");
    expect(record.keys).toBe(3);
    expect(typeof record.ts).toBe("string");
  });

  it("sends errors to stderr and everything else to stdout", () => {
    const out = captureOut();
    const err = captureErr();

    log.info("in", {});
    log.warn("warned", {});
    log.error("failed", {});

    expect(out.lines).toHaveLength(2);
    expect(err.lines).toHaveLength(1);
    const errored: unknown = JSON.parse(err.lines[0] ?? "{}");
    out.restore();
    err.restore();

    expect(errored).toMatchObject({ level: "error", msg: "failed" });
  });

  it("never emits secret key material for a Keypair", () => {
    // JSON.stringify on a Keypair emits _secretSeed and _secretKey as byte
    // arrays — the whole secret, recoverable. Reduce it to the public key.
    const keypair = Keypair.random();
    const seedBytes = [...keypair.rawSecretKey()];

    const out = captureOut();
    log.info("signing", { keypair });
    const line = out.lines[0] ?? "";
    out.restore();

    expect(line).toContain(keypair.publicKey());
    expect(line).not.toContain(keypair.secret());
    expect(line).not.toContain("_secretSeed");
    expect(line).not.toContain("_secretKey");
    // The byte-array form is the real leak; assert the bytes themselves are gone.
    expect(line).not.toContain(seedBytes.join(","));
  });

  it("never emits secret key material for a nested or wrapped Keypair", () => {
    // JSON.stringify recurses, so a top-level-only guard is not enough. Each of
    // these shapes leaked the seed bytes before the walker was added.
    const keypair = Keypair.random();
    const seedBytes = [...keypair.rawSecretKey()].join(",");

    const shapes: Record<string, unknown> = {
      nested: { ctx: { signer: keypair } },
      inArray: { signers: [keypair] },
      deep: { a: { b: { c: { d: keypair } } } },
      rawBuffer: { raw: keypair.rawSecretKey() },
    };

    for (const [name, fields] of Object.entries(shapes)) {
      const out = captureOut();
      log.info(name, fields as Record<string, unknown>);
      const line = out.lines[0] ?? "";
      out.restore();

      expect(line, `${name} leaked seed bytes`).not.toContain(seedBytes);
      expect(line, `${name} leaked a secret field`).not.toContain("_secretSeed");
      expect(line, `${name} leaked a secret field`).not.toContain("_secretKey");
    }
  });

  it("renders byte buffers as a length, never contents", () => {
    const out = captureOut();
    log.info("bytes", { blob: Buffer.from([1, 2, 3, 4]) });
    const record = soleRecord(out.lines);
    out.restore();

    expect(record.blob).toBe("<4 bytes>");
  });

  it("renders the same object twice when it appears in sibling fields", () => {
    // Cycle tracking is path-scoped; a repeated value is not a cycle.
    const shared = { id: "repeated" };
    const out = captureOut();
    log.info("siblings", { first: shared, second: shared });
    const record = soleRecord(out.lines);
    out.restore();

    expect(record.first).toEqual({ id: "repeated" });
    expect(record.second).toEqual({ id: "repeated" });
  });

  it("stringifies bigint rather than throwing", () => {
    const out = captureOut();
    expect(() => log.info("ledger", { seq: 9007199254740993n })).not.toThrow();
    const record = soleRecord(out.lines);
    out.restore();

    expect(record.seq).toBe("9007199254740993");
  });

  it("reduces an Error to name and message", () => {
    const out = captureOut();
    log.info("caught", { cause: new TypeError("bad thing") });
    const record = soleRecord(out.lines);
    out.restore();

    expect(record.cause).toBe("TypeError: bad thing");
  });

  it("marks a cycle and keeps the surrounding fields", () => {
    // A logging failure must never take down a running daemon. The walker
    // replaces the cycle, so the rest of the line survives instead of the whole
    // record collapsing into an error.
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    const out = captureOut();
    expect(() => log.info("cyclic", { circular, contract: "CABC" })).not.toThrow();
    const record = soleRecord(out.lines);
    out.restore();

    expect(record.msg).toBe("cyclic");
    expect(record.contract).toBe("CABC");
    expect(record.circular).toEqual({ name: "loop", self: "<circular>" });
  });

  it("falls back to an error line when a field cannot be read at all", () => {
    const hostile = {
      get boom(): never {
        throw new Error("getter exploded");
      },
    };

    const out = captureOut();
    expect(() => log.info("hostile", { hostile })).not.toThrow();
    const record = soleRecord(out.lines);
    out.restore();

    expect(record.msg).toBe("hostile");
    expect(record.logError).toContain("getter exploded");
  });

  it("stops walking past the depth cap", () => {
    let deep: Record<string, unknown> = { end: "bottom" };
    for (let i = 0; i < 10; i += 1) deep = { down: deep };

    const out = captureOut();
    expect(() => log.info("deep", deep)).not.toThrow();
    const line = out.lines[0] ?? "";
    out.restore();

    expect(line).toContain("<max depth>");
  });
});
