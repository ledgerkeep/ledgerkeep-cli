# ledgerkeep-cli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the off-chain keeper CLI for LedgerKeep — scan Soroban contract TTL, extend it by two explicitly-chosen paths, and run as a daemon that maintains registered contracts and reports manifest drift.

**Architecture:** A thin `commander` entrypoint over four layers: an RPC layer that builds ledger keys and reads TTL, an ops layer with two independent extension paths, a registry layer that pages the on-chain directory, and a keeper layer whose policy and drift logic are pure functions over plain data so they test without a network.

**Tech Stack:** Node.js (engines `>=22`), TypeScript 5.x strict, `@stellar/stellar-sdk` 16.2.0, `commander`, `vitest`, `eslint` + `@typescript-eslint`, `prettier`.

**Design spec:** `docs/superpowers/specs/2026-08-02-ledgerkeep-cli-design.md`. Read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `engines: ">=22"`. CI runs Node 22 and 24.
- `@stellar/stellar-sdk` pinned to exactly `16.2.0`. No caret, no tilde.
- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`.
- `package.json` has `"type": "module"`. **All relative imports carry a `.js` extension**, including in test files. This is required by `NodeNext`.
- No `any`. Narrow from `unknown`. No non-null `!` assertions except immediately after a checked throw.
- No bare `console.log` outside `src/log.ts`. The logger is the only writer to stdout/stderr.
- No secret key in a flag, in source, in a log, or in output.
- Ledger values are integers. No floats, no `parseFloat` over SDK strings.
- Named exports only. No default exports.
- Never `git add .` after Task 1. Stage by explicit path.
- Conventional commits, scopes: `setup`, `rpc`, `ops`, `registry`, `commands`, `keeper`, `docs`, `ci`.
- **No `Co-Authored-By` trailer. No generated-with footer.** Plain commit messages only.
- Push after every commit: `git push origin main`.
- Before any commit touching logic: `npm run build`, `npm run lint`, `npm test` all clean.

## Verified SDK facts

These were confirmed against the installed 16.2.0 package. Do not re-derive them; do not substitute names from older tutorials.

| Fact | Value |
|---|---|
| RPC import | `import { rpc } from "@stellar/stellar-sdk"` or `from "@stellar/stellar-sdk/rpc"`. Both resolve. |
| TTL operation | `Operation.extendFootprintTtl({ extendTo })`. `bumpFootprintExpiration` is **removed**. |
| Soroban data | `SorobanDataBuilder` has `setResourceFee`, `setReadOnly`, `setReadWrite`, `getReadOnly`, `getReadWrite`, `getFootprint`, `build`. |
| Simulation footprint | `sim.transactionData` is a `SorobanDataBuilder`. Call `.getReadOnly()` and `.getReadWrite()` for `xdr.LedgerKey[]`. |
| Simulation error check | `rpc.Api.isSimulationError(sim)` |
| Assemble | `rpc.assembleTransaction(tx, sim).build()` |
| Batch read | `server.getLedgerEntries(...keys)` — **spread args, not an array**. Returns `{ entries, latestLedger }`. |
| Entry shape | `{ key, val, lastModifiedLedgerSeq?, liveUntilLedgerSeq? }`. Missing entries are **omitted** from `entries`. |
| Poll | `server.pollTransaction(hash)` — use this, do not hand-roll a `getTransaction` loop. |
| Read-only calls | `server.queryContract<T>(contractId, method, args?)` → `{ result, isReadCall }`. Uses `NULL_ACCOUNT` internally, so **no key and no funded account are needed**. |
| Instance key | `xdr.ScVal.scvLedgerKeyContractInstance()`, hex `00000014` |
| Durability | `xdr.ContractDataDurability.persistent()` / `.temporary()` |

## File structure

| File | Responsibility |
|---|---|
| `src/index.ts` | commander entrypoint, wires subcommands, sets exit codes |
| `src/config.ts` | env loading, validation, keypair loading from file path |
| `src/log.ts` | structured JSON logging; only module that writes to stdout |
| `src/rpc/client.ts` | `Server` construction from config |
| `src/rpc/keys.ts` | ledger key construction, manifest decode, ScVal rendering |
| `src/rpc/ttl.ts` | batched TTL read, remaining-life computation, status classification |
| `src/ops/extendViaContract.ts` | Path A — invoke `extend_all` |
| `src/ops/extendViaFootprint.ts` | Path B — raw `extendFootprintTtl` |
| `src/registry/discover.ts` | page the registry, decode entries |
| `src/keeper/policy.ts` | pure: threshold decision |
| `src/keeper/drift.ts` | pure: footprint diff and threshold-gated TTL diff |
| `src/keeper/loop.ts` | daemon scheduling and per-contract orchestration |
| `src/commands/scan.ts` | `lkeep scan` |
| `src/commands/extend.ts` | `lkeep extend` |
| `src/commands/registryList.ts` | `lkeep registry-list` |
| `src/commands/keep.ts` | `lkeep keep` |
| `test/keys.test.ts` | key round-trip, ScVal rendering |
| `test/ttl.test.ts` | remaining life, archived detection |
| `test/config.test.ts` | env validation, and that no error message echoes key file contents |
| `test/log.test.ts` | stream routing, bigint and Error handling, Keypair redaction, circular safety |
| `test/policy.test.ts` | maintenance decision |
| `test/drift.test.ts` | both drift directions, above-threshold non-drift |
| `test/discover.test.ts` | decode real manifest fixtures from core |

## Deviations from the original brief

Stated once here so the implementer does not "correct" them back:

1. `module`/`moduleResolution` are `NodeNext`, not `ES2022`/`bundler`. With plain `tsc` output on Node, `bundler` emits extensionless imports that Node's ESM loader rejects.
2. `src/log.ts` is built in Task 6, before ops and commands, because they depend on it. The brief ordered it 19th.
3. `src/keeper/drift.ts` is a new module, split out of `policy.ts`.
4. `LK_RENT_VAULT_ID` is absent. No command reads it.
5. Read-only commands use `NULL_ACCOUNT` via `queryContract`, so they need no signing key.
6. Task 10 carries a live testnet smoke check. It is the first network contact in the
   build and gates the registry commit, so RPC and key-construction faults surface at
   the point they are introduced rather than after the commands are built on top.
7. `.github/workflows/ci.yml` is created in Task 2, not Task 1, and Task 1 does not gate
   on `npm run build`. Task 1 creates no `src/` file, so `tsc` exits 2 on `TS18003: No
   inputs were found` — correct behaviour for an empty source tree, and not suppressible
   the way vitest's `passWithNoTests` is. Adding a placeholder `src/index.ts` to satisfy
   the gate would be exactly the stub this project forbids. Deferring the workflow by one
   task also means CI's first run is green rather than red.
8. `.prettierignore` is not in the brief. Without it `prettier --check .` fails on the
   spec and plan under `docs/`, which would turn CI red the moment the workflow lands.
   Prettier governs code here, not prose.
9. Task 2 does not define a `NetworkConfig` interface. An earlier draft of this plan
   did, but nothing ever consumed it — Task 5's `Config` carries `rpcUrl` and
   `networkPassphrase` along with everything else, and every caller takes that. A type
   no caller uses is the speculative code this project forbids.
10. `src/log.ts` carries no `/* eslint-disable no-console */`. `eslint.config.js`
   already turns the rule off for exactly this file, so the inline directive is
   redundant and eslint reports it as an unused-directive warning on every run. A
   permanently-warning build teaches people to ignore warnings.
11. `serialize` redacts through a recursive walker, not a top-level check. A
   top-level guard was tried first and was not enough: `JSON.stringify` recurses,
   so `{ctx:{signer}}`, `{signers:[k]}` and a raw `Buffer` of seed bytes each
   emitted the secret in the clear. Byte views are rendered as a length because
   the logger cannot tell a harmless buffer from 32 bytes of seed. Verified, not
   assumed:
   `JSON.stringify(Keypair.random())` emits `_secretSeed` and `_secretKey` as byte
   arrays — the complete secret in recoverable form. An earlier draft of this plan
   claimed a `Keypair` "would serialize to `{}` rather than a secret". That was
   false, and it is exactly the kind of comment that makes a later maintainer
   comfortable logging one.
12. Path B rejects a restore-required simulation; Path A does not. `isSimulationError`
   is false for one — `restorePreamble` rides on a *success* response — and
   `assembleTransaction` gates on `isSimulationSuccess`, which accepts it. Path B would
   therefore have signed, paid for, and submitted a transaction the RPC had already
   said could not succeed, and the operator would have seen only `ended FAILED` with the
   server's hint discarded. For a TTL keeper an archived entry is the likeliest real
   failure, so it must be named. Path A takes no such guard on purpose: Protocol 23
   restores archived persistent entries automatically inside an InvokeHostFunctionOp
   footprint, which is what `extend_all` is, and the spec already relies on that ("the
   next Path A run restores it as a side effect"). ExtendFootprintTTLOp restores nothing.
13. Only `PENDING` proceeds to `pollTransaction`. An earlier draft rejected `ERROR`
   alone, letting `TRY_AGAIN_LATER` and `DUPLICATE` through — neither was ever queued,
   so the poll burned its full ~30s budget against a hash the network did not have and
   then reported `ended NOT_FOUND`, misattributing back-pressure to a failed
   transaction. The rejection message also decodes `errorResult.result().switch().name`
   rather than `JSON.stringify`-ing the XDR struct, which emits js-xdr `_maxDepth` and
   `_armType` plumbing with the result code buried inside.
14. `extendTo` is relative, not absolute. An earlier draft's comment called it "an
   absolute target in ledgers from the current one, not a delta". The SDK is explicit:
   "TTL is the number of ledgers from the current ledger (exclusive) until the last
   ledger the entry is still considered alive". A caller trusting the old wording would
   pass `currentLedger + N` and overshoot the maximum TTL. This is the module's only
   numeric cross-task contract, so a wrong comment on it is worse than none.
15. `discoverAll` unwraps a `contract.Ok` rather than checking `Array.isArray`. The
   registry's `page` returns a Rust `Result`, and the SDK decodes it into its own
   `Ok`/`Err` wrapper. An earlier draft checked the raw value with `Array.isArray` and
   would have thrown "did not return a list" on every real page — the code would have
   passed every unit test and failed against the only chain it will ever run on. This
   is exactly what the Task 10 smoke check exists to catch, and it caught it. Related:
   `count` returns a plain number, so the two calls are not symmetric, and a
   non-numeric count is now rejected rather than silently producing zero contracts —
   a keeper that discovers nothing maintains nothing while still looking healthy.
16. The Task 10 fixture's contract id was fictional. The key *bytes* were real
   (verified against core in Task 3), but the id `CA3D5KRY…` matched nothing on chain,
   so the fixture only looked like the deployed escrow. It is now the real
   `CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6`, and the smoke check
   compares against the ids in core's README rather than an unset `LK_LONG_ESCROW_ID`.
17. The brief's commits 4 and 5 are one commit. Commit 4 was "pin the SDK and verify the
   import surface", which produces no file of its own — the pin lives in `package.json`
   from Task 1 and the verification is recorded above and re-run in Task 2. That makes
   25 implementation commits rather than 26. An empty commit would be worse.
18. Task 12 gained a twelfth test, "does not report a key sitting exactly at threshold
   that did not move". Mutation testing found that changing `ttlDrift`'s gate from
   `>= threshold` to `> threshold` passed all eleven original tests. Soroban's
   `extend_ttl` writes only when remaining life is *strictly below* threshold, so a key
   exactly at it is supposed to stay put; under `>` the daemon would report drift on a
   healthy contract — the precise false positive the threshold gate exists to prevent.
   Task 11's policy test already covers this boundary ("treats exactly at threshold as
   healthy"); drift now does too.
19. Task 16's `runLoop` leaked an abort listener per tick. The original wait registered
   `signal.addEventListener("abort", ..., { once: true })` on every iteration, but
   `{ once: true }` only removes the listener if the event fires — and on a healthy
   daemon it never does, because each tick ends by timing out instead. I measured it:
   200 ticks retained 200 listeners, growing without bound in the one component
   designed to run indefinitely. At the default 60s interval that is 1440 retained
   closures per day, each pinning a timer and a resolve. The wait now removes the
   listener explicitly on the timeout path, which measures 0 retained after 200 ticks.
20. Task 16's `runTick` logs "tick start" before registry discovery rather than after,
   and reports the contract count in a new "registry discovered" line. Found by running
   the daemon and reading its log, not by review. Discovery is a 2-3 second network
   round trip, and logging "tick start" only once it returned left the tick's opening
   seconds silent. A SIGINT landing in that window printed "stopping" before "tick
   start", which reads as though the daemon began a fresh tick after being told to
   stop. It does not — a controlled abort test aborting mid-wait exits without starting
   another tick, twice — but the log said otherwise. On a funded keeper that is the
   difference between "stopped cleanly" and "kept spending after I hit ctrl-c". The
   misordering fooled me during verification, which is the evidence it would fool an
   operator reading the same lines.
21. Task 18's README told operators to run `stellar keys show alice`. That subcommand
   does not exist. Verified against the stellar-cli cookbook and against
   FULL_HELP_DOCS.md on main, which lists a `secret` subcommand ("Output an identity's
   secret key") and no `show` subcommand at all. The README now says
   `stellar keys secret alice`. Every operator following the setup instructions
   verbatim would have hit a command-not-found at the one step that produces the
   keeper key.
22. Task 18's README example contract id `CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K`
   is a structurally valid strkey that is not deployed on testnet. Scanning it returns
   `status: "archived"`, `liveUntilLedgerSeq: null` — a copy-pasted example that makes
   the tool look like it found a dying contract when it found nothing at all. Replaced
   with the real deployed escrow. This is the third fictional-id defect in this plan
   (see 16), and the reason to only ever put ids in docs that were read off chain.

---

### Task 1: Scaffold the repository

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.prettierrc.json`, `.prettierignore`, `eslint.config.js`, `.env.example`, `README.md`, `LICENSE`, `vitest.config.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `npm run build`, `npm run lint`, `npm run format:check`, `npm test` scripts that all later tasks run

**`npm run build` does not pass in this task, and that is expected.** `tsconfig.json`
sets `include: ["src/**/*.ts"]` and Task 1 creates no source file, so `tsc` exits 2 with
`TS18003: No inputs were found`. That is the empty-tree case, not a broken build, and
`tsc` has no `passWithNoTests` equivalent to suppress it. Do not add a placeholder
`src/` file to silence it — Task 2 writes the first real source file and the build
passes from there on. The CI workflow is deferred to Task 2 for the same reason, so
CI's first run lands on a commit where all four checks pass.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ledgerkeep-cli",
  "version": "0.1.0",
  "description": "Off-chain keeper for LedgerKeep. Scan and extend Soroban contract TTL.",
  "license": "Apache-2.0",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "bin": {
    "lkeep": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run"
  },
  "dependencies": {
    "@stellar/stellar-sdk": "16.2.0",
    "commander": "^14.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@typescript-eslint/eslint-plugin": "^8.20.0",
    "@typescript-eslint/parser": "^8.20.0",
    "eslint": "^9.18.0",
    "prettier": "^3.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
coverage/
.DS_Store
```

- [ ] **Step 4: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 4b: Create `.prettierignore`**

`format:check` runs `prettier --check .`, which otherwise sweeps the spec and plan under
`docs/` and the scratch files under `.superpowers/`. Prettier reflows markdown prose in
ways that churn those files for no benefit, and the plan is read by line during
execution. `package-lock.json` is excluded because npm regenerates it in its own format,
which would fight `format --write` on every install.

```
dist
node_modules
package-lock.json

# Prose, not code. Prettier reflows markdown in ways that churn the spec and plan
# for no benefit, and the plan is read by line during execution.
docs
.superpowers
```

- [ ] **Step 5: Create `eslint.config.js`**

```js
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-console": "error",
      // Named exports only. Expressed as restricted syntax rather than
      // import/no-default-export so this needs no extra plugin.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Named exports only. No default exports.",
        },
      ],
    },
  },
  {
    files: ["src/log.ts"],
    rules: { "no-console": "off" },
  },
];
```

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 7: Create `.env.example`**

No real value appears here. `LK_KEEPER_KEY` is a path, never a secret.

```
# Soroban RPC endpoint.
LK_RPC_URL=https://soroban-testnet.stellar.org

# Network passphrase. Must match the network the RPC endpoint serves.
LK_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Deployed registry contract ID.
LK_REGISTRY_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Path to a file containing the keeper's secret seed, one line, nothing else.
# This is a PATH, not a key. Never put a secret seed in this file or in a flag.
# Export it once from stellar-cli, then chmod 600 it.
LK_KEEPER_KEY=/home/you/.ledgerkeep/keeper.key

# Extend when remaining ledgers fall below this.
LK_THRESHOLD=100000

# Target TTL in ledgers.
LK_EXTEND_TO=500000

# Daemon scan period in milliseconds.
LK_SCAN_INTERVAL_MS=60000
```

- [ ] **Step 8: Create `README.md` skeleton**

```markdown
# ledgerkeep-cli

Off-chain keeper for LedgerKeep. Scans Soroban contract storage TTL and extends it
before entries expire.

A Soroban contract cannot read the time-to-live of its own storage at runtime. It
can extend TTL and record that it did, but it cannot observe how close an entry is
to expiry. This tool makes that observation.

The on-chain half — the `maintainable` standard, the `registry`, and the
`rent_vault` — lives in [ledgerkeep-core](https://github.com/ledgerkeep/ledgerkeep-core).

## Status

Under construction. See `docs/superpowers/plans/2026-08-02-ledgerkeep-cli.md`.

## License

Apache-2.0
```

- [ ] **Step 9: Copy the Apache-2.0 LICENSE from core**

```bash
cp ../Ledgerkeep-core/LICENSE ./LICENSE
```

- [ ] **Step 10: Install and verify the toolchain**

```bash
npm install
npm run format:check && npm run lint && npm test
```

Expected: all three clean. `lint` exits 0 (it matches no files yet, which is not an
error). `test` reports "No test files found" and exits 0 — vitest `run` with no tests
exits 0 only if `passWithNoTests` is set, so if it fails here, add
`"passWithNoTests": true` to `vitest.config.ts` under `test`.

`format:check` is part of the gate because CI runs it. If it flags any file, run
`npm run format` and re-check — do not commit with it failing.

Do **not** run `npm run build` as a gate here. See the note under **Files** above: with
no `src/` file, `tsc` exits 2 on `TS18003`, which is the correct result for an empty
source tree. Task 2 adds the first source file, and the build gate applies from that
task onward.

- [ ] **Step 11: Commit the scaffold**

Stage by explicit path even here. `git add .` would swallow the README and
`.env.example` that Step 12 commits separately, leaving it with nothing to stage.

```bash
git add package.json package-lock.json tsconfig.json .gitignore .prettierrc.json .prettierignore eslint.config.js vitest.config.ts LICENSE
git commit -m "chore(setup): scaffold package.json, tsconfig, eslint, prettier, gitignore"
git push origin main
```

- [ ] **Step 12: Commit the docs**

```bash
git add README.md .env.example
git commit -m "docs(setup): add README skeleton and .env.example"
git push origin main
```

Confirm the tree is clean afterward: `git status --porcelain` prints nothing apart from
untracked `.superpowers/`.

---

### Task 2: RPC client and network config

**Files:**
- Create: `src/rpc/client.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: `makeServer(rpcUrl: string): rpc.Server`

- [ ] **Step 1: Record the SDK verification result**

The brief's commit 4 asks for verification before writing RPC code. It is already done
and recorded in the "Verified SDK facts" table above. Confirm it still holds on the
installed tree, which takes one command:

```bash
node --input-type=module -e "
import { Operation, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { Server, Api, assembleTransaction } from '@stellar/stellar-sdk/rpc';
console.log('extendFootprintTtl:', typeof Operation.extendFootprintTtl);
console.log('bumpFootprintExpiration:', typeof Operation.bumpFootprintExpiration);
console.log('setResourceFee:', typeof SorobanDataBuilder.prototype.setResourceFee);
console.log('getReadOnly:', typeof SorobanDataBuilder.prototype.getReadOnly);
console.log('assembleTransaction:', typeof assembleTransaction);
console.log('isSimulationError:', typeof Api.isSimulationError);
console.log('pollTransaction:', typeof Server.prototype.pollTransaction);
console.log('queryContract:', typeof Server.prototype.queryContract);
console.log('scvLedgerKeyContractInstance:', typeof xdr.ScVal.scvLedgerKeyContractInstance);
"
```

Expected: every line `function` except `bumpFootprintExpiration: undefined`.
If any line differs, **stop and report it** rather than working around it.

- [ ] **Step 2: Write `src/rpc/client.ts`**

```ts
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
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build && npm run lint`
Expected: both clean.

- [ ] **Step 4: Commit**

The brief splits this into commits 4 and 5. Commit 4 has no file change of its own —
the verification is recorded in the plan and re-run in Step 1 — so this is one commit.

```bash
git add src/rpc/client.ts
git commit -m "feat(rpc): add Server client and network config"
git push origin main
```

- [ ] **Step 5: Create `.github/workflows/ci.yml`**

This lands here rather than in Task 1 so CI's first run is against a commit where all
four checks pass. In Task 1 there is no `src/` file, so `npm run build` fails on
`TS18003` and the workflow's first run would be red.

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run format:check
      - run: npm run lint
      - run: npm run build
      - run: npm test
```

- [ ] **Step 6: Verify the workflow's checks pass locally before pushing it**

Run: `npm run format:check && npm run lint && npm run build && npm test`
Expected: all four clean. This is the exact sequence the workflow runs, so a local pass
means the first CI run is green. If `format:check` fails, run `npm run format` and
re-check.

- [ ] **Step 7: Commit the CI workflow**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(setup): add build, lint, test workflow"
git push origin main
```

---

### Task 3: Ledger key construction and XDR helpers

**Files:**
- Create: `src/rpc/keys.ts`
- Test: `test/keys.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `INSTANCE_KEY_HEX: "00000014"`
  - `instanceScVal(): xdr.ScVal`
  - `decodeManifestKey(raw: Buffer): xdr.ScVal`
  - `contractDataKey(contractId: string, key: xdr.ScVal, durability: xdr.ContractDataDurability): xdr.LedgerKey`
  - `instanceLedgerKey(contractId: string): xdr.LedgerKey`
  - `manifestLedgerKeys(contractId: string, keysXdr: Buffer[]): xdr.LedgerKey[]`
  - `describeScVal(value: xdr.ScVal): string`
  - `keyId(key: xdr.LedgerKey): string`
  - `parseScValFromHexOrBase64(input: string): xdr.ScVal`

- [ ] **Step 1: Write the failing test**

Create `test/keys.test.ts`. The three hex fixtures are the escrow's real manifest,
copied from `ledgerkeep-core/scripts/init_testnet.sh`.

```ts
import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  INSTANCE_KEY_HEX,
  contractDataKey,
  decodeManifestKey,
  describeScVal,
  instanceLedgerKey,
  instanceScVal,
  keyId,
  manifestLedgerKeys,
  parseScValFromHexOrBase64,
} from "../src/rpc/keys.js";

// A real testnet contract ID. Any valid C-address works; this one is only a
// well-formed sample for key construction.
const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

const INSTANCE_HEX = "00000014";
const BALANCE_HEX = "0000001000000001000000010000000f0000000742616c616e636500";
const MILESTONES_HEX = "0000001000000001000000010000000f0000000a4d696c6573746f6e65730000";

describe("instance key", () => {
  it("encodes to the same hex the core registry uses", () => {
    expect(instanceScVal().toXDR("hex")).toBe(INSTANCE_KEY_HEX);
    expect(INSTANCE_KEY_HEX).toBe(INSTANCE_HEX);
  });

  it("round-trips through decodeManifestKey", () => {
    const decoded = decodeManifestKey(Buffer.from(INSTANCE_HEX, "hex"));
    expect(decoded.switch().name).toBe("scvLedgerKeyContractInstance");
    expect(decoded.toXDR("hex")).toBe(INSTANCE_HEX);
  });
});

describe("manifest key decoding", () => {
  it("decodes the escrow Balance key to Vec[Symbol(Balance)]", () => {
    const decoded = decodeManifestKey(Buffer.from(BALANCE_HEX, "hex"));
    expect(describeScVal(decoded)).toBe("Vec[Symbol(Balance)]");
  });

  it("decodes the escrow Milestones key to Vec[Symbol(Milestones)]", () => {
    const decoded = decodeManifestKey(Buffer.from(MILESTONES_HEX, "hex"));
    expect(describeScVal(decoded)).toBe("Vec[Symbol(Milestones)]");
  });

  it("renders the instance key by name", () => {
    expect(describeScVal(instanceScVal())).toBe("LedgerKeyContractInstance");
  });
});

describe("ledger key construction", () => {
  it("round-trips a persistent contract data key", () => {
    const key = contractDataKey(
      CONTRACT,
      instanceScVal(),
      xdr.ContractDataDurability.persistent(),
    );
    const reparsed = xdr.LedgerKey.fromXDR(key.toXDR());
    expect(reparsed.toXDR("base64")).toBe(key.toXDR("base64"));
    expect(reparsed.switch().name).toBe("contractData");
    expect(reparsed.contractData().durability().name).toBe("persistent");
  });

  it("builds every manifest key against one contract", () => {
    const keys = manifestLedgerKeys(CONTRACT, [
      Buffer.from(INSTANCE_HEX, "hex"),
      Buffer.from(BALANCE_HEX, "hex"),
      Buffer.from(MILESTONES_HEX, "hex"),
    ]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys.map(keyId)).size).toBe(3);
  });

  it("gives instanceLedgerKey the same id as the manifest instance entry", () => {
    const fromManifest = manifestLedgerKeys(CONTRACT, [Buffer.from(INSTANCE_HEX, "hex")])[0];
    if (fromManifest === undefined) throw new Error("expected one key");
    expect(keyId(fromManifest)).toBe(keyId(instanceLedgerKey(CONTRACT)));
  });

  it("rejects a malformed contract id with a named error", () => {
    expect(() => instanceLedgerKey("not-a-contract")).toThrow(/not a valid contract id/i);
  });
});

describe("parseScValFromHexOrBase64", () => {
  it("accepts hex", () => {
    expect(parseScValFromHexOrBase64(BALANCE_HEX).toXDR("hex")).toBe(BALANCE_HEX);
  });

  it("accepts base64", () => {
    const b64 = Buffer.from(BALANCE_HEX, "hex").toString("base64");
    expect(parseScValFromHexOrBase64(b64).toXDR("hex")).toBe(BALANCE_HEX);
  });

  it("rejects garbage", () => {
    expect(() => parseScValFromHexOrBase64("zzzz")).toThrow(/could not decode/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/keys.test.ts`
Expected: FAIL — cannot resolve `../src/rpc/keys.js`.

- [ ] **Step 3: Write `src/rpc/keys.ts`**

```ts
import { Address, xdr } from "@stellar/stellar-sdk";

/**
 * `ScVal::LedgerKeyContractInstance`, XDR-encoded.
 *
 * This is the key of a contract's instance entry, and the same literal the core
 * registry's constructor publishes in its own manifest.
 */
export const INSTANCE_KEY_HEX = "00000014";

/** The `ScVal` naming a contract's instance entry. */
export function instanceScVal(): xdr.ScVal {
  return xdr.ScVal.scvLedgerKeyContractInstance();
}

/**
 * Decode one raw manifest entry.
 *
 * A registry manifest holds XDR-encoded `ScVal` as `Bytes`, never decoded
 * on-chain. This is where it becomes a value we can build a ledger key from.
 */
export function decodeManifestKey(raw: Buffer): xdr.ScVal {
  try {
    return xdr.ScVal.fromXDR(raw);
  } catch (cause) {
    const hex = raw.toString("hex");
    throw new Error(`manifest entry is not a valid ScVal: ${hex}`, { cause });
  }
}

/** Accept a key supplied on the command line as either hex or base64. */
export function parseScValFromHexOrBase64(input: string): xdr.ScVal {
  const trimmed = input.trim();
  const encodings: Array<"hex" | "base64"> = /^[0-9a-fA-F]+$/.test(trimmed)
    ? ["hex", "base64"]
    : ["base64", "hex"];
  for (const encoding of encodings) {
    try {
      return xdr.ScVal.fromXDR(Buffer.from(trimmed, encoding));
    } catch {
      continue;
    }
  }
  throw new Error(`could not decode --key as hex or base64 ScVal: ${input}`);
}

function toScAddress(contractId: string): xdr.ScAddress {
  try {
    return Address.fromString(contractId).toScAddress();
  } catch (cause) {
    throw new Error(`not a valid contract id: ${contractId}`, { cause });
  }
}

/** Build a `ContractData` ledger key. Used for both reading TTL and Path B. */
export function contractDataKey(
  contractId: string,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: toScAddress(contractId),
      key,
      durability,
    }),
  );
}

/**
 * The ledger key of a contract's instance entry.
 *
 * Instance entries are `ContractData` with persistent durability, which is why
 * this is not a separate durability case.
 */
export function instanceLedgerKey(contractId: string): xdr.LedgerKey {
  return contractDataKey(contractId, instanceScVal(), xdr.ContractDataDurability.persistent());
}

/**
 * Build every ledger key a manifest declares.
 *
 * Durability is always persistent. `impl_maintainable!` touches only
 * `instance()` and `persistent()` storage, and instance entries are themselves
 * persistent `ContractData`, so no manifest key can be temporary.
 */
export function manifestLedgerKeys(contractId: string, keysXdr: Buffer[]): xdr.LedgerKey[] {
  return keysXdr.map((raw) =>
    contractDataKey(contractId, decodeManifestKey(raw), xdr.ContractDataDurability.persistent()),
  );
}

/** A stable identity for a ledger key, for set membership and map lookups. */
export function keyId(key: xdr.LedgerKey): string {
  return key.toXDR("base64");
}

/**
 * Render an `ScVal` for a human.
 *
 * The registry stores no per-key labels, so a decoded rendering of the key
 * itself is the most descriptive thing a scan can print.
 */
export function describeScVal(value: xdr.ScVal): string {
  switch (value.switch().name) {
    case "scvLedgerKeyContractInstance":
      return "LedgerKeyContractInstance";
    case "scvSymbol":
      return `Symbol(${value.sym().toString()})`;
    case "scvString":
      return `String(${value.str().toString()})`;
    case "scvU32":
      return `U32(${value.u32()})`;
    case "scvI32":
      return `I32(${value.i32()})`;
    case "scvU64":
      return `U64(${value.u64().toString()})`;
    case "scvI64":
      return `I64(${value.i64().toString()})`;
    case "scvBool":
      return `Bool(${value.b()})`;
    case "scvAddress":
      return `Address(${Address.fromScAddress(value.address()).toString()})`;
    case "scvVec": {
      const items = value.vec() ?? [];
      return `Vec[${items.map(describeScVal).join(", ")}]`;
    }
    case "scvMap": {
      const entries = value.map() ?? [];
      return `Map{${entries
        .map((e) => `${describeScVal(e.key())}: ${describeScVal(e.val())}`)
        .join(", ")}}`;
    }
    default:
      return `${value.switch().name}(${value.toXDR("base64")})`;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/keys.test.ts`
Expected: PASS, 12 tests.

If `describeScVal` returns `Vec[Symbol(Balance)]` but the test expected something
else, trust the test — those hex strings are the deployed values and the rendering
must match what they decode to.

- [ ] **Step 5: Verify the whole toolchain**

Run: `npm run build && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 6: Commit implementation and test separately**

The brief keeps these as commits 6 and 7.

```bash
git add src/rpc/keys.ts
git commit -m "feat(rpc): add ledger key construction and XDR helpers"
git push origin main

git add test/keys.test.ts
git commit -m "test(rpc): ledger key round-trip for instance and persistent keys"
git push origin main
```

---

### Task 4: TTL read and remaining-life computation

**Files:**
- Create: `src/rpc/ttl.ts`
- Test: `test/ttl.test.ts`

**Interfaces:**
- Consumes: `keyId`, `describeScVal` from `src/rpc/keys.js`
- Produces:
  - `type TtlStatus = "ok" | "low" | "archived"`
  - `interface TtlReading { key: xdr.LedgerKey; keyId: string; description: string; durability: string; liveUntilLedgerSeq: number | null; remaining: number; status: TtlStatus }`
  - `remainingLife(liveUntilLedgerSeq: number | undefined, latestLedger: number): number`
  - `classify(remaining: number, threshold: number): TtlStatus`
  - `buildReadings(keys, entries, latestLedger, threshold): TtlReading[]`
  - `readTtl(server, keys, threshold): Promise<{ readings: TtlReading[]; latestLedger: number }>`

`buildReadings` is split out from `readTtl` so the classification logic is testable
without a network. `readTtl` is the only part that does I/O.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { instanceLedgerKey, contractDataKey, keyId } from "../src/rpc/keys.js";
import { buildReadings, classify, remainingLife } from "../src/rpc/ttl.js";

const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

function symbolKey(name: string): xdr.LedgerKey {
  return contractDataKey(
    CONTRACT,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
    xdr.ContractDataDurability.persistent(),
  );
}

describe("remainingLife", () => {
  it("subtracts the latest ledger from live-until", () => {
    expect(remainingLife(500_000, 100_000)).toBe(400_000);
  });

  it("treats a missing live-until as archived, reporting zero", () => {
    expect(remainingLife(undefined, 100_000)).toBe(0);
  });

  it("clamps a past live-until to zero rather than going negative", () => {
    expect(remainingLife(90_000, 100_000)).toBe(0);
  });

  it("returns zero exactly at the boundary", () => {
    expect(remainingLife(100_000, 100_000)).toBe(0);
  });
});

describe("classify", () => {
  it("is archived at zero remaining", () => {
    expect(classify(0, 100_000)).toBe("archived");
  });

  it("is low below the threshold", () => {
    expect(classify(99_999, 100_000)).toBe("low");
  });

  it("is ok exactly at the threshold", () => {
    expect(classify(100_000, 100_000)).toBe("ok");
  });

  it("is ok above the threshold", () => {
    expect(classify(400_000, 100_000)).toBe("ok");
  });
});

describe("buildReadings", () => {
  it("pairs each requested key with its entry", () => {
    const keys = [instanceLedgerKey(CONTRACT), symbolKey("Balance")];
    const entries = [
      { key: keys[0], val: {}, liveUntilLedgerSeq: 600_000 },
      { key: keys[1], val: {}, liveUntilLedgerSeq: 150_000 },
    ];
    const readings = buildReadings(keys, entries, 100_000, 100_000);

    expect(readings).toHaveLength(2);
    expect(readings[0]?.remaining).toBe(500_000);
    expect(readings[0]?.status).toBe("ok");
    expect(readings[0]?.description).toBe("LedgerKeyContractInstance");
    expect(readings[1]?.remaining).toBe(50_000);
    expect(readings[1]?.status).toBe("low");
    expect(readings[1]?.description).toBe("Vec[Symbol(Balance)]");
  });

  it("marks a key the RPC omitted as archived", () => {
    const keys = [instanceLedgerKey(CONTRACT), symbolKey("Milestones")];
    const entries = [{ key: keys[0], val: {}, liveUntilLedgerSeq: 600_000 }];
    const readings = buildReadings(keys, entries, 100_000, 100_000);

    expect(readings).toHaveLength(2);
    expect(readings[1]?.status).toBe("archived");
    expect(readings[1]?.liveUntilLedgerSeq).toBeNull();
    expect(readings[1]?.remaining).toBe(0);
  });

  it("preserves the requested key order regardless of response order", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const balance = symbolKey("Balance");
    const keys = [instance, balance];
    const entries = [
      { key: balance, val: {}, liveUntilLedgerSeq: 150_000 },
      { key: instance, val: {}, liveUntilLedgerSeq: 600_000 },
    ];
    const readings = buildReadings(keys, entries, 100_000, 100_000);

    expect(readings[0]?.keyId).toBe(keyId(instance));
    expect(readings[1]?.keyId).toBe(keyId(balance));
  });

  it("reports durability so a scan table can show it", () => {
    const keys = [symbolKey("Balance")];
    const readings = buildReadings(keys, [], 100_000, 100_000);
    expect(readings[0]?.durability).toBe("persistent");
  });
});
```

Every access above uses `?.` or a named local. The lint config bans non-null `!`
assertions in `test/**` as well as `src/**`, so bind the key to a `const` rather
than indexing and asserting.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ttl.test.ts`
Expected: FAIL — cannot resolve `../src/rpc/ttl.js`.

- [ ] **Step 3: Write `src/rpc/ttl.ts`**

```ts
import { rpc, xdr } from "@stellar/stellar-sdk";
import { describeScVal, keyId } from "./keys.js";

/** How healthy one storage entry is. */
export type TtlStatus = "ok" | "low" | "archived";

/** One entry's observed time-to-live. */
export interface TtlReading {
  key: xdr.LedgerKey;
  keyId: string;
  description: string;
  durability: string;
  liveUntilLedgerSeq: number | null;
  remaining: number;
  status: TtlStatus;
}

/**
 * The RPC caps how many keys one `getLedgerEntries` call accepts. Requests are
 * chunked below that cap rather than relying on the server's limit.
 */
const MAX_KEYS_PER_REQUEST = 100;

/**
 * Ledgers of life left in an entry.
 *
 * A missing `liveUntilLedgerSeq` means the RPC has no live entry for the key, and
 * a live-until at or before the latest ledger means it has expired. Both report
 * zero; neither is allowed to go negative, because callers compare against a
 * threshold and a negative value would sort below every other reading for no
 * useful reason.
 */
export function remainingLife(
  liveUntilLedgerSeq: number | undefined,
  latestLedger: number,
): number {
  if (liveUntilLedgerSeq === undefined) return 0;
  return Math.max(0, liveUntilLedgerSeq - latestLedger);
}

/** Classify remaining life against a threshold. */
export function classify(remaining: number, threshold: number): TtlStatus {
  if (remaining <= 0) return "archived";
  if (remaining < threshold) return "low";
  return "ok";
}

/** The `entries` shape `buildReadings` needs. Structural, so tests can fake it. */
interface EntryLike {
  key: xdr.LedgerKey;
  liveUntilLedgerSeq?: number;
}

function durabilityName(key: xdr.LedgerKey): string {
  if (key.switch().name !== "contractData") return "unknown";
  return key.contractData().durability().name;
}

/**
 * Pair every requested key with its entry.
 *
 * The RPC omits keys it has no entry for, so results are matched by key rather
 * than by position, and a key with no match is reported archived. Output order
 * follows the requested order so a scan table is stable across runs.
 */
export function buildReadings(
  keys: xdr.LedgerKey[],
  entries: EntryLike[],
  latestLedger: number,
  threshold: number,
): TtlReading[] {
  const byId = new Map<string, EntryLike>();
  for (const entry of entries) {
    byId.set(keyId(entry.key), entry);
  }

  return keys.map((key) => {
    const id = keyId(key);
    const entry = byId.get(id);
    const liveUntil = entry?.liveUntilLedgerSeq;
    const remaining = remainingLife(liveUntil, latestLedger);
    return {
      key,
      keyId: id,
      description:
        key.switch().name === "contractData"
          ? describeScVal(key.contractData().key())
          : key.switch().name,
      durability: durabilityName(key),
      liveUntilLedgerSeq: liveUntil ?? null,
      remaining,
      status: classify(remaining, threshold),
    };
  });
}

/**
 * Read TTL for a batch of ledger keys.
 *
 * The only function in this module that performs I/O.
 */
export async function readTtl(
  server: rpc.Server,
  keys: xdr.LedgerKey[],
  threshold: number,
): Promise<{ readings: TtlReading[]; latestLedger: number }> {
  if (keys.length === 0) {
    return { readings: [], latestLedger: 0 };
  }

  const collected: EntryLike[] = [];
  let latestLedger = 0;

  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_REQUEST) {
    const chunk = keys.slice(i, i + MAX_KEYS_PER_REQUEST);
    let response: rpc.Api.GetLedgerEntriesResponse;
    try {
      response = await server.getLedgerEntries(...chunk);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`getLedgerEntries failed: ${message}`, { cause });
    }
    collected.push(...response.entries);
    latestLedger = Math.max(latestLedger, response.latestLedger);
  }

  return { readings: buildReadings(keys, collected, latestLedger, threshold), latestLedger };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/ttl.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the whole toolchain**

Run: `npm run build && npm run lint && npm test`
Expected: all clean, 24 tests total.

- [ ] **Step 6: Commit implementation and test separately**

```bash
git add src/rpc/ttl.ts
git commit -m "feat(rpc): add TTL read and remaining-life computation"
git push origin main

git add test/ttl.test.ts
git commit -m "test(rpc): remaining-life and archived-entry detection"
git push origin main
```

---

### Task 5: Config loading, validation, and keypair resolution

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Config { rpcUrl; networkPassphrase; registryId; keeperKeyPath; threshold; extendTo; scanIntervalMs }`
  - `loadConfig(env?: NodeJS.ProcessEnv): Config`
  - `loadKeypair(config: Config): Keypair`

Validation is total: every variable is checked at load. The keeper key **file** is not
read at load — only its path is recorded — so `scan` and `registry-list` run without a
key present. `loadKeypair` is what reads it, and only signing commands call it.

- [ ] **Step 1: Write `src/config.ts`**

```ts
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
  } catch (cause) {
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
```

- [ ] **Step 2: Verify it compiles and lints**

Run: `npm run build && npm run lint`
Expected: clean. If lint flags the unused `cause` binding in `loadKeypair`, drop the
binding: `} catch {`.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(setup): add env loading and validation"
git push origin main
```

---

### Task 6: Structured JSON logger

**Files:**
- Create: `src/log.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `log.info(msg, fields?)`, `log.warn(msg, fields?)`, `log.error(msg, fields?)`, `type LogFields = Record<string, unknown>`

Built here rather than at the brief's position 19 because every module from Task 7
onward logs. This is the only module allowed to write to stdout or stderr.

- [ ] **Step 1: Write `src/log.ts`**

```ts
import { Keypair } from "@stellar/stellar-sdk";

/** Extra structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

type Level = "info" | "warn" | "error";

/** Nested fields deeper than this are replaced rather than walked. */
const MAX_DEPTH = 6;

/**
 * Rewrite one value into something safe to serialize.
 *
 * This walks nested objects and arrays rather than only the top level. A
 * top-level-only guard is not enough: `JSON.stringify` recurses, so a `Keypair`
 * at `{ ctx: { signer } }` or `{ signers: [k] }` reaches the output just as
 * readily as one passed directly.
 *
 * - `bigint` is stringified, because `JSON.stringify` throws on it and ledger
 *   math elsewhere may hand us one.
 * - A `Keypair` becomes its public key. `JSON.stringify` on one emits
 *   `_secretSeed` and `_secretKey` as plain byte arrays — the whole secret, in
 *   recoverable form, with no `S...` string present to notice.
 * - Any byte view, `Buffer` included, becomes a length. The logger cannot tell
 *   a harmless buffer from 32 bytes of seed, and nothing here needs raw bytes.
 * - An `Error` becomes name and message. A stack makes a daemon tail unreadable.
 *
 * `seen` tracks the current path only, so a value repeated in two sibling fields
 * renders twice rather than being mislabelled as a cycle.
 */
function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Keypair) return value.publicKey();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (ArrayBuffer.isView(value)) return `<${value.byteLength} bytes>`;
  if (value === null || typeof value !== "object") return value;

  if (depth >= MAX_DEPTH) return "<max depth>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redact(item, seen, depth + 1));
    }
    const out: LogFields = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redact(nested, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Serialize one line of JSON.
 *
 * A logging failure must never take down a running daemon, so both the walk and
 * the stringify are wrapped. `redact` already replaces cycles, so the fallback
 * covers what is left: a throwing getter, or a `toJSON` that misbehaves.
 */
function serialize(level: Level, msg: string, fields: LogFields): string {
  const ts = new Date().toISOString();
  try {
    const seen = new WeakSet<object>();
    const record: LogFields = { ts, level, msg };
    for (const [key, value] of Object.entries(fields)) {
      record[key] = redact(value, seen, 0);
    }
    return JSON.stringify(record);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return JSON.stringify({
      ts,
      level,
      msg,
      logError: `failed to serialize fields: ${reason}`,
    });
  }
}

function emit(level: Level, msg: string, fields: LogFields = {}): void {
  const line = serialize(level, msg, fields);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * The only writer to stdout and stderr in this program.
 *
 * `info` marks actions, `warn` marks drift and low TTL, `error` marks RPC and
 * signing failures. Callers pass plain fields; a `Keypair` that reaches here is
 * reduced to its public key by `serialize`.
 */
export const log = {
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};
```

- [ ] **Step 2: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean. The `no-console` override in `eslint.config.js` covers this file;
the inline `eslint-disable` is belt and braces and can stay.

- [ ] **Step 3: Commit**

```bash
git add src/log.ts
git commit -m "feat(log): add structured JSON logger"
git push origin main
```

---

### Task 7: Path B — raw `extendFootprintTtl`

**Files:**
- Create: `src/ops/extendViaFootprint.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.js`, `log` from `src/log.js`
- Produces:
  - `interface SubmitResult { hash: string; minResourceFee: string; status: string }`
  - `buildFootprintTx(params): Transaction`
  - `extendViaFootprint(params): Promise<SubmitResult>`

- [ ] **Step 1: Write `src/ops/extendViaFootprint.ts`**

```ts
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
 * modify entry data. `extendTo` is the minimum TTL, counted in ledgers past the
 * current ledger, that every key in the read-only footprint will have after the
 * operation; entries already above it are skipped.
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
  // isSimulationError is not enough: a restore-required simulation is a
  // *success* response with an extra `restorePreamble` field, not an error.
  // Submitting it anyway would sign and pay for a transaction the RPC has
  // already told us cannot succeed as written, against archived entries.
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new Error(
      `${keys.length} entr${keys.length === 1 ? "y" : "ies"} require restoring before their TTL can be extended`,
    );
  }

  log.info("simulated footprint extension", {
    keys: keys.length,
    extendTo,
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
    throw new Error(`transaction ${sent.hash} ended ${final.status}`);
  }

  return { hash: sent.hash, minResourceFee: sim.minResourceFee, status: final.status };
}
```

- [ ] **Step 2: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ops/extendViaFootprint.ts
git commit -m "feat(ops): add Path B extendFootprintTtl builder with simulate and submit"
git push origin main
```

---

### Task 8: Path A — invoke `extend_all`

**Files:**
- Create: `src/ops/extendViaContract.ts`

**Interfaces:**
- Consumes: `log` from `src/log.js`
- Produces:
  - `interface ContractExtendResult extends SubmitResult { footprint: xdr.LedgerKey[] }`
  - `simulateExtendAll(params): Promise<{ footprint: xdr.LedgerKey[]; minResourceFee: string }>`
  - `extendViaContract(params): Promise<ContractExtendResult>`
  - `footprintKeysForContract(data: SorobanDataBuilder, contractId: string): xdr.LedgerKey[]`

`simulateExtendAll` is separate from `extendViaContract` because drift detection needs
the footprint **without** submitting or paying anything.

- [ ] **Step 1: Write `src/ops/extendViaContract.ts`**

```ts
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
    throw new Error(`transaction ${sent.hash} ended ${final.status}`);
  }

  return {
    hash: sent.hash,
    minResourceFee: sim.minResourceFee,
    status: final.status,
    footprint: footprintKeysForContract(sim.transactionData, contractId),
  };
}
```

- [ ] **Step 2: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/ops/extendViaContract.ts
git commit -m "feat(ops): add Path A extend_all invocation"
git push origin main
```

---

### Task 9: Footprint construction test

**Files:**
- Create: `test/ops.test.ts`

**Interfaces:**
- Consumes: `buildFootprintTx` from `src/ops/extendViaFootprint.js`, `footprintKeysForContract` from `src/ops/extendViaContract.js`
- Produces: nothing

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "vitest";
import { Account, Networks, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { contractDataKey, instanceLedgerKey, keyId } from "../src/rpc/keys.js";
import { buildFootprintTx } from "../src/ops/extendViaFootprint.js";
import { footprintKeysForContract } from "../src/ops/extendViaContract.js";

const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const OTHER = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

function symbolKey(contract: string, name: string): xdr.LedgerKey {
  return contractDataKey(
    contract,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
    xdr.ContractDataDurability.persistent(),
  );
}

describe("buildFootprintTx", () => {
  it("puts the keys in the read-only footprint and uses extendTo", () => {
    const keys = [instanceLedgerKey(CONTRACT), symbolKey(CONTRACT, "Balance")];
    const tx = buildFootprintTx(new Account(SOURCE, "0"), {
      networkPassphrase: Networks.TESTNET,
      keys,
      extendTo: 500_000,
    });

    const data = new SorobanDataBuilder(tx.toEnvelope().v1().tx().ext().sorobanData());
    expect(data.getReadOnly().map(keyId)).toEqual(keys.map(keyId));
    expect(data.getReadWrite()).toHaveLength(0);

    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0];
    if (op === undefined) throw new Error("expected one operation");
    expect(op.type).toBe("extendFootprintTtl");
  });

  it("carries the extendTo value onto the operation", () => {
    const tx = buildFootprintTx(new Account(SOURCE, "0"), {
      networkPassphrase: Networks.TESTNET,
      keys: [instanceLedgerKey(CONTRACT)],
      extendTo: 123_456,
    });
    const op = tx.operations[0];
    if (op === undefined || op.type !== "extendFootprintTtl") {
      throw new Error("expected an extendFootprintTtl operation");
    }
    expect(op.extendTo).toBe(123_456);
  });
});

describe("footprintKeysForContract", () => {
  it("unions read-only and read-write", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const balance = symbolKey(CONTRACT, "Balance");
    const data = new SorobanDataBuilder().setReadOnly([balance]).setReadWrite([instance]).build();

    const found = footprintKeysForContract(new SorobanDataBuilder(data), CONTRACT);
    expect(new Set(found.map(keyId))).toEqual(new Set([keyId(instance), keyId(balance)]));
  });

  it("drops keys belonging to another contract", () => {
    const mine = instanceLedgerKey(CONTRACT);
    const theirs = symbolKey(OTHER, "Balance");
    const data = new SorobanDataBuilder().setReadOnly([mine, theirs]).build();

    const found = footprintKeysForContract(new SorobanDataBuilder(data), CONTRACT);
    expect(found.map(keyId)).toEqual([keyId(mine)]);
  });

  it("deduplicates a key present in both halves", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const data = new SorobanDataBuilder().setReadOnly([instance]).setReadWrite([instance]).build();

    const found = footprintKeysForContract(new SorobanDataBuilder(data), CONTRACT);
    expect(found).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/ops.test.ts`
Expected: PASS, 5 tests.

If reading the Soroban data back off the built transaction proves awkward, the
first test may instead assert on the `SorobanDataBuilder` the function was given —
but prefer the round-trip through the built transaction, since that is what
actually gets submitted.

- [ ] **Step 3: Run everything**

Run: `npm run build && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add test/ops.test.ts
git commit -m "test(ops): footprint construction for a known key"
git push origin main
```

---

### Task 10: Registry discovery

**Files:**
- Create: `src/registry/discover.ts`
- Test: `test/discover.test.ts`

**Interfaces:**
- Consumes: `rpc.Server`
- Produces:
  - `interface ManifestEntry { contract: string; keysXdr: Buffer[]; threshold: number; extendTo: number; registered: number; updated: number }`
  - `PAGE_LIMIT = 50`
  - `decodeEntry(raw: unknown): ManifestEntry`
  - `unwrapPage(raw: unknown, start: number): unknown[]`
  - `discoverAll(server: rpc.Server, registryId: string): Promise<ManifestEntry[]>`

The registry's `page` caps `limit` at 50 and errors `LimitTooLarge` above it, so
`PAGE_LIMIT` is 50 exactly and paging stops when a page returns short.

`decodeEntry` and `unwrapPage` are separate from `discoverAll` so the fixture tests
run with no network.

**Read this before writing `discoverAll`.** These were confirmed against the live
testnet registry `CB7K56KG3KHC43FROV534M55FMVGBW24NUFQSXSRMH7OS54242GFYMGN`, not
inferred from the Rust source:

| Call | What actually comes back |
|---|---|
| `count` | a plain `number` — `2` |
| `page(start=0, limit=50)` | `Ok([...])`, the SDK's `contract.Ok` wrapper around the list — **not** a bare array |
| `page(start=999, limit=50)` | `Ok([])`, so the short-page break still works |
| `page(limit=51)` | throws inside simulation: `HostError: Error(Contract, #105)`. An oversized limit never arrives as an `Err` value |

`contract.Ok` and `contract.Err` are exported from `@stellar/stellar-sdk` and carry
`unwrap()`, `unwrapErr()`, `isOk()`, `isErr()`. An earlier draft of this plan checked
`Array.isArray(page)` directly and would have rejected every real page.

- [ ] **Step 1: Write the failing test**

The fixture is a real `RegistryEntry` as `scValToNative` produces it: snake_case
fields from the Rust `#[contracttype]`, `Address` as a string, `Bytes` as a Buffer.
The contract id and the three key values are the escrow's live deployed manifest,
read off testnet and pasted here.

```ts
import { describe, expect, it } from "vitest";
import { contract as contractSpec } from "@stellar/stellar-sdk";
import { decodeEntry, unwrapPage } from "../src/registry/discover.js";
import { describeScVal, decodeManifestKey, manifestLedgerKeys } from "../src/rpc/keys.js";

/** The long_escrow example, as deployed to testnet by core's `init_testnet.sh`. */
const ESCROW = "CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6";

const INSTANCE_HEX = "00000014";
const BALANCE_HEX = "0000001000000001000000010000000f0000000742616c616e636500";
const MILESTONES_HEX = "0000001000000001000000010000000f0000000a4d696c6573746f6e65730000";

function fixture(): Record<string, unknown> {
  return {
    contract: ESCROW,
    keys_xdr: [
      Buffer.from(INSTANCE_HEX, "hex"),
      Buffer.from(BALANCE_HEX, "hex"),
      Buffer.from(MILESTONES_HEX, "hex"),
    ],
    threshold: 100_000,
    extend_to: 500_000,
    registered: 1_234,
    updated: 5_678,
  };
}

describe("decodeEntry", () => {
  it("maps the on-chain snake_case fields to camelCase", () => {
    const entry = decodeEntry(fixture());
    expect(entry.contract).toBe(ESCROW);
    expect(entry.threshold).toBe(100_000);
    expect(entry.extendTo).toBe(500_000);
    expect(entry.registered).toBe(1_234);
    expect(entry.updated).toBe(5_678);
    expect(entry.keysXdr).toHaveLength(3);
  });

  it("produces keys that decode to the escrow's real manifest", () => {
    const entry = decodeEntry(fixture());
    const described = entry.keysXdr.map((raw) => describeScVal(decodeManifestKey(raw)));
    expect(described).toEqual([
      "LedgerKeyContractInstance",
      "Vec[Symbol(Balance)]",
      "Vec[Symbol(Milestones)]",
    ]);
  });

  it("produces keys that build into three distinct ledger keys", () => {
    const entry = decodeEntry(fixture());
    const keys = manifestLedgerKeys(entry.contract, entry.keysXdr);
    expect(keys).toHaveLength(3);
  });

  it("accepts a Uint8Array where the SDK did not hand back a Buffer", () => {
    const raw = fixture();
    raw.keys_xdr = [new Uint8Array(Buffer.from(INSTANCE_HEX, "hex"))];
    const entry = decodeEntry(raw);
    expect(describeScVal(decodeManifestKey(entry.keysXdr[0] as Buffer))).toBe(
      "LedgerKeyContractInstance",
    );
  });

  it("rejects an entry missing keys_xdr", () => {
    const raw = fixture();
    delete raw.keys_xdr;
    expect(() => decodeEntry(raw)).toThrow(/keys_xdr/);
  });

  it("rejects a non-object", () => {
    expect(() => decodeEntry("nope")).toThrow(/registry entry/i);
  });
});

describe("unwrapPage", () => {
  it("unwraps the Ok the registry actually returns", () => {
    // The live registry returns a Rust Result, which the SDK hands back as Ok,
    // not as a bare array. Checking Array.isArray on the raw value rejected
    // every real page.
    const entries = [fixture()];
    expect(unwrapPage(new contractSpec.Ok(entries), 0)).toEqual(entries);
  });

  it("treats an exhausted page as empty rather than an error", () => {
    expect(unwrapPage(new contractSpec.Ok([]), 999)).toEqual([]);
  });

  it("throws on an Err, naming the start offset", () => {
    expect(() => unwrapPage(new contractSpec.Err("LimitTooLarge"), 50)).toThrow(/start=50/);
  });

  it("throws when the payload is not a list", () => {
    expect(() => unwrapPage(new contractSpec.Ok("nope"), 0)).toThrow(/did not return a list/);
    expect(() => unwrapPage(42, 0)).toThrow(/did not return a list/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/discover.test.ts`
Expected: FAIL — cannot resolve `../src/registry/discover.js`.

- [ ] **Step 3: Write `src/registry/discover.ts`**

```ts
import { contract as contractSpec, rpc } from "@stellar/stellar-sdk";

/** One contract's published maintenance manifest, decoded. */
export interface ManifestEntry {
  contract: string;
  keysXdr: Buffer[];
  threshold: number;
  extendTo: number;
  registered: number;
  updated: number;
}

/**
 * The registry rejects a `limit` above 50 with `LimitTooLarge`, so this is the
 * largest page it will serve.
 */
export const PAGE_LIMIT = 50;

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`registry entry is not an object: ${JSON.stringify(raw)}`);
  }
  return raw as Record<string, unknown>;
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`registry entry field ${field} is not an integer: ${String(value)}`);
}

function requireBytes(record: Record<string, unknown>, field: string): Buffer[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new Error(`registry entry field ${field} is not an array`);
  }
  return value.map((item, index) => {
    if (Buffer.isBuffer(item)) return item;
    if (item instanceof Uint8Array) return Buffer.from(item);
    throw new Error(`registry entry field ${field}[${index}] is not bytes`);
  });
}

/**
 * Convert one native-decoded `RegistryEntry` into our shape.
 *
 * The on-chain struct uses Rust field names, so `keys_xdr` and `extend_to` arrive
 * snake_case. `Bytes` decodes to a `Buffer` under Node but the check accepts any
 * `Uint8Array`, because that is the weaker guarantee the SDK actually makes.
 */
export function decodeEntry(raw: unknown): ManifestEntry {
  const record = asRecord(raw);
  const contract = record["contract"];
  if (typeof contract !== "string") {
    throw new Error("registry entry field contract is not an address string");
  }
  return {
    contract,
    keysXdr: requireBytes(record, "keys_xdr"),
    threshold: requireNumber(record, "threshold"),
    extendTo: requireNumber(record, "extend_to"),
    registered: requireNumber(record, "registered"),
    updated: requireNumber(record, "updated"),
  };
}

/**
 * Unwrap one page of registry entries.
 *
 * The registry's `page` returns a Rust `Result`, and the SDK decodes that into
 * its own `Ok`/`Err` wrapper rather than a bare list. Verified against the
 * deployed testnet registry, not assumed: a good page arrives as `Ok([...])`,
 * a `start` past the end arrives as `Ok([])`, and a `limit` above 50 fails
 * inside simulation with `Error(Contract, #105)` — so an oversized limit is a
 * thrown error from `queryContract`, never an `Err` value here.
 *
 * `count`, by contrast, returns a plain number. The two are not symmetric.
 */
export function unwrapPage(raw: unknown, start: number): unknown[] {
  if (raw instanceof contractSpec.Err) {
    throw new Error(`registry page at start=${start} returned an error: ${String(raw.unwrapErr())}`);
  }
  const value = raw instanceof contractSpec.Ok ? raw.unwrap() : raw;
  if (!Array.isArray(value)) {
    throw new Error(`registry page at start=${start} did not return a list`);
  }
  return value;
}

/**
 * Read every registered contract.
 *
 * Pages through `count` and `page`. The registry self-registers in its own
 * constructor, so it appears in this list and is maintained like any other
 * contract.
 *
 * `queryContract` simulates against the SDK's null account, so this needs no
 * signing key and no funded account.
 */
export async function discoverAll(
  server: rpc.Server,
  registryId: string,
): Promise<ManifestEntry[]> {
  let total: number;
  try {
    const { result } = await server.queryContract<number>(registryId, "count");
    total = Number(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not read registry count from ${registryId}: ${message}`, { cause });
  }
  // A non-number here would make the loop below run zero times and return an
  // empty list, so a keeper daemon would report "0 contracts" and sit there
  // maintaining nothing while looking healthy. Fail loudly instead.
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`registry count from ${registryId} is not a whole number: ${String(total)}`);
  }

  const entries: ManifestEntry[] = [];
  for (let start = 0; start < total; start += PAGE_LIMIT) {
    let page: unknown;
    try {
      const { result } = await server.queryContract<unknown>(registryId, "page", {
        start,
        limit: PAGE_LIMIT,
      });
      page = result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`registry page at start=${start} failed: ${message}`, { cause });
    }

    const items = unwrapPage(page, start);
    if (items.length === 0) break;
    for (const item of items) {
      entries.push(decodeEntry(item));
    }
  }

  return entries;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/discover.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run everything**

Run: `npm run build && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 6: Live smoke check against testnet**

**This is the first code in the project that talks to a real network.** Everything
before it is offline. Run it here rather than after the commands are built, so a
broken RPC URL, network passphrase, or contract-id assumption fails at the task
that introduced it instead of eight tasks later.

Requires a configured environment. Load your `.env` first:

```bash
set -a && . ./.env && set +a
npm run build
node --input-type=module -e "
import { makeServer } from './dist/rpc/client.js';
import { discoverAll } from './dist/registry/discover.js';
const server = makeServer(process.env.LK_RPC_URL);
const entries = await discoverAll(server, process.env.LK_REGISTRY_ID);
console.log('registered contracts:', entries.length);
for (const e of entries) {
  console.log(' -', e.contract, 'keys=' + e.keysXdr.length,
              'threshold=' + e.threshold, 'extendTo=' + e.extendTo);
}
"
```

Expected against the deployed testnet set — this is what the live chain returned
when this plan was written, so treat any difference as a real finding:

```
registered contracts: 2
 - CB7K56KG3KHC43FROV534M55FMVGBW24NUFQSXSRMH7OS54242GFYMGN keys=1 threshold=100000 extendTo=500000
 - CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6 keys=3 threshold=100000 extendTo=500000
```

The first is the registry itself, which self-registers in its constructor and is
maintained like any other contract. The second is the long_escrow example.

Read the failure rather than working around it:

| Symptom | Cause |
|---|---|
| `could not read registry count` | `LK_RPC_URL` wrong, unreachable, or pointed at a network where the registry is not deployed |
| `is not a valid contract id` | `LK_REGISTRY_ID` malformed |
| `has no method 'count'` | `LK_REGISTRY_ID` points at some other contract |
| 0 entries | Connected to the wrong network, or `init_testnet.sh` never ran |
| `keys_xdr` decode error | The manifest on-chain differs from what `decodeEntry` expects — **stop and report**, do not loosen the decoder |

Confirm one manifest decodes to the real escrow keys:

```bash
node --input-type=module -e "
import { makeServer } from './dist/rpc/client.js';
import { discoverAll } from './dist/registry/discover.js';
import { decodeManifestKey, describeScVal } from './dist/rpc/keys.js';
const server = makeServer(process.env.LK_RPC_URL);
const entries = await discoverAll(server, process.env.LK_REGISTRY_ID);
for (const e of entries) {
  console.log(e.contract, e.keysXdr.map((k) => describeScVal(decodeManifestKey(k))));
}
"
```

Expected: the escrow prints exactly
`[ 'LedgerKeyContractInstance', 'Vec[Symbol(Balance)]', 'Vec[Symbol(Milestones)]' ]`,
matching the fixture in `test/discover.test.ts` and the values in core's
`scripts/init_testnet.sh`. The registry prints
`[ 'LedgerKeyContractInstance' ]`. If the fixture and the live chain disagree, the
fixture is wrong — report it before continuing.

The live key bytes were read off testnet and are the fixture's hex verbatim:
`00000014`, `0000001000000001000000010000000f0000000742616c616e636500`, and
`0000001000000001000000010000000f0000000a4d696c6573746f6e65730000`.

This step commits nothing. It is a gate.

- [ ] **Step 7: Commit implementation and test separately**

```bash
git add src/registry/discover.ts
git commit -m "feat(registry): add discovery via count and page with entry decoding"
git push origin main

git add test/discover.test.ts
git commit -m "test(registry): decode a registry entry fixture"
git push origin main
```

---

### Task 11: Threshold policy

**Files:**
- Create: `src/keeper/policy.ts`
- Test: `test/policy.test.ts`

**Interfaces:**
- Consumes: `TtlReading` from `src/rpc/ttl.js`
- Produces:
  - `effectiveThreshold(registered: number, fallback: number): number`
  - `interface MaintenanceDecision { needed: boolean; reason: string; lowKeys: string[]; archivedKeys: string[] }`
  - `decideMaintenance(readings: TtlReading[], threshold: number): MaintenanceDecision`

Pure. No I/O, no SDK calls beyond types.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { TtlReading } from "../src/rpc/ttl.js";
import { instanceLedgerKey } from "../src/rpc/keys.js";
import { decideMaintenance, effectiveThreshold } from "../src/keeper/policy.js";

/** The long_escrow example as deployed to testnet. Used only to build a real key. */
const ESCROW = "CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6";

function reading(description: string, remaining: number, threshold = 100_000): TtlReading {
  return {
    // A real key rather than a cast placeholder. `undefined as unknown as
    // xdr.LedgerKey` lies to the type checker, and the test would crash oddly
    // rather than fail clearly if the policy ever read this field.
    key: instanceLedgerKey(ESCROW),
    keyId: `id:${description}`,
    description,
    durability: "persistent",
    liveUntilLedgerSeq: remaining > 0 ? remaining + 1_000 : null,
    remaining,
    status: remaining <= 0 ? "archived" : remaining < threshold ? "low" : "ok",
  };
}

describe("effectiveThreshold", () => {
  it("uses the registered value when it is set", () => {
    expect(effectiveThreshold(250_000, 100_000)).toBe(250_000);
  });

  it("falls back when the registered value is zero", () => {
    expect(effectiveThreshold(0, 100_000)).toBe(100_000);
  });

  it("falls back on a negative registered value", () => {
    expect(effectiveThreshold(-1, 100_000)).toBe(100_000);
  });
});

describe("decideMaintenance", () => {
  it("does not need maintenance when every key is healthy", () => {
    const decision = decideMaintenance(
      [reading("instance", 400_000), reading("Balance", 300_000)],
      100_000,
    );
    expect(decision.needed).toBe(false);
    expect(decision.lowKeys).toEqual([]);
    expect(decision.archivedKeys).toEqual([]);
  });

  it("needs maintenance when one key is below threshold", () => {
    const decision = decideMaintenance(
      [reading("instance", 400_000), reading("Balance", 50_000)],
      100_000,
    );
    expect(decision.needed).toBe(true);
    expect(decision.lowKeys).toEqual(["Balance"]);
  });

  it("needs maintenance when a key is archived", () => {
    const decision = decideMaintenance(
      [reading("instance", 400_000), reading("Milestones", 0)],
      100_000,
    );
    expect(decision.needed).toBe(true);
    expect(decision.archivedKeys).toEqual(["Milestones"]);
  });

  it("treats exactly at threshold as healthy", () => {
    const decision = decideMaintenance([reading("instance", 100_000)], 100_000);
    expect(decision.needed).toBe(false);
  });

  it("does not need maintenance for an empty reading set", () => {
    const decision = decideMaintenance([], 100_000);
    expect(decision.needed).toBe(false);
    expect(decision.reason).toMatch(/no keys/i);
  });

  it("reports every low key, not just the first", () => {
    const decision = decideMaintenance(
      [reading("Balance", 10_000), reading("Milestones", 20_000)],
      100_000,
    );
    expect(decision.lowKeys).toEqual(["Balance", "Milestones"]);
  });

  it("gives a reason naming the counts", () => {
    const decision = decideMaintenance(
      [reading("Balance", 10_000), reading("Milestones", 0)],
      100_000,
    );
    expect(decision.reason).toContain("1 low");
    expect(decision.reason).toContain("1 archived");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/policy.test.ts`
Expected: FAIL — cannot resolve `../src/keeper/policy.js`.

- [ ] **Step 3: Write `src/keeper/policy.ts`**

```ts
import type { TtlReading } from "../rpc/ttl.js";

/** Why a contract does or does not need maintenance now. */
export interface MaintenanceDecision {
  needed: boolean;
  reason: string;
  lowKeys: string[];
  archivedKeys: string[];
}

/**
 * The threshold to judge a contract by.
 *
 * A registered threshold of zero means the contract published no useful value,
 * so the operator's `LK_THRESHOLD` stands in. Anything positive wins, because the
 * contract knows its own needs better than a global default does.
 */
export function effectiveThreshold(registered: number, fallback: number): number {
  return registered > 0 ? registered : fallback;
}

/**
 * Decide whether a contract needs maintenance.
 *
 * Needed when any observed key is below threshold or already archived. Pure, so
 * the daemon's decision is testable without a network.
 */
export function decideMaintenance(
  readings: TtlReading[],
  threshold: number,
): MaintenanceDecision {
  if (readings.length === 0) {
    return { needed: false, reason: "no keys observed", lowKeys: [], archivedKeys: [] };
  }

  const lowKeys: string[] = [];
  const archivedKeys: string[] = [];

  for (const reading of readings) {
    if (reading.remaining <= 0) {
      archivedKeys.push(reading.description);
    } else if (reading.remaining < threshold) {
      lowKeys.push(reading.description);
    }
  }

  const needed = lowKeys.length > 0 || archivedKeys.length > 0;
  const reason = needed
    ? `${lowKeys.length} low, ${archivedKeys.length} archived, threshold ${threshold}`
    : `all ${readings.length} keys above threshold ${threshold}`;

  return { needed, reason, lowKeys, archivedKeys };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/policy.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit implementation and test separately**

```bash
git add src/keeper/policy.ts
git commit -m "feat(keeper): add threshold policy"
git push origin main

git add test/policy.test.ts
git commit -m "test(keeper): policy decides maintenance from remaining life"
git push origin main
```

---

### Task 12: Drift detection

**Files:**
- Create: `src/keeper/drift.ts`
- Test: `test/drift.test.ts`

**Interfaces:**
- Consumes: `keyId`, `describeScVal` from `src/rpc/keys.js`; `TtlReading` from `src/rpc/ttl.js`
- Produces:
  - `type DriftKind = "manifest-declares-unextended" | "manifest-omits-extended"`
  - `interface DriftFinding { kind: DriftKind; keyId: string; description: string; detail: string }`
  - `footprintDrift(manifestKeys: xdr.LedgerKey[], footprintKeys: xdr.LedgerKey[]): DriftFinding[]`
  - `ttlDrift(before: TtlReading[], after: TtlReading[], threshold: number): DriftFinding[]`

**This is the task the whole redesign exists for. Read this before writing code:**

`impl_maintainable!` calls `env.storage().persistent().extend_ttl(key, threshold,
extend_to)`. Soroban's `extend_ttl` is **conditional** — it writes only when the
entry's remaining life is already below `threshold`. A key that is comfortably
alive is *supposed* not to move when `extend_all` runs.

So `ttlDrift` must judge **only keys that were below threshold beforehand**. Judging
every key would report healthy contracts as drifted on nearly every tick, because
the daemon fires when any one key is low while the rest are typically fine. The
test named "does not report a key that was above threshold and did not move" is the
regression guard for exactly that. Do not weaken it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { contractDataKey, instanceLedgerKey, keyId } from "../src/rpc/keys.js";
import type { TtlReading } from "../src/rpc/ttl.js";
import { footprintDrift, ttlDrift } from "../src/keeper/drift.js";

const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

function symbolKey(name: string): xdr.LedgerKey {
  return contractDataKey(
    CONTRACT,
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
    xdr.ContractDataDurability.persistent(),
  );
}

function reading(key: xdr.LedgerKey, description: string, remaining: number): TtlReading {
  return {
    key,
    keyId: keyId(key),
    description,
    durability: "persistent",
    liveUntilLedgerSeq: remaining > 0 ? remaining + 1_000 : null,
    remaining,
    status: remaining <= 0 ? "archived" : remaining < 100_000 ? "low" : "ok",
  };
}

describe("footprintDrift", () => {
  it("finds nothing when the manifest and footprint agree", () => {
    const keys = [instanceLedgerKey(CONTRACT), symbolKey("Balance")];
    expect(footprintDrift(keys, keys)).toEqual([]);
  });

  it("flags a manifest key the contract never touches", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const stale = symbolKey("RemovedKey");
    const findings = footprintDrift([instance, stale], [instance]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("manifest-declares-unextended");
    expect(findings[0]?.description).toBe("Vec[Symbol(RemovedKey)]");
  });

  it("flags a key the contract extends but the manifest omits", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const undeclared = symbolKey("NewKey");
    const findings = footprintDrift([instance], [instance, undeclared]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("manifest-omits-extended");
    expect(findings[0]?.description).toBe("Vec[Symbol(NewKey)]");
  });

  it("reports both directions at once", () => {
    const instance = instanceLedgerKey(CONTRACT);
    const findings = footprintDrift(
      [instance, symbolKey("Gone")],
      [instance, symbolKey("Added")],
    );
    expect(findings.map((f) => f.kind).sort()).toEqual([
      "manifest-declares-unextended",
      "manifest-omits-extended",
    ]);
  });

  it("ignores ordering differences", () => {
    const a = instanceLedgerKey(CONTRACT);
    const b = symbolKey("Balance");
    expect(footprintDrift([a, b], [b, a])).toEqual([]);
  });
});

describe("ttlDrift", () => {
  it("does not report a key that was above threshold and did not move", () => {
    // The regression guard. extend_ttl is conditional: a healthy key is supposed
    // to stay put, and calling that drift would fire on every healthy contract.
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 400_000)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 400_000)];
    expect(ttlDrift(before, after, 100_000)).toEqual([]);
  });

  it("does not report a key sitting exactly at threshold that did not move", () => {
    // extend_ttl writes only when remaining life is strictly below threshold, so
    // a key exactly at it is supposed to stay put. Without this case, changing
    // the gate from `>=` to `>` passes every other test in this file.
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 100_000)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 100_000)];
    expect(ttlDrift(before, after, 100_000)).toEqual([]);
  });

  it("reports a key that was below threshold and did not move", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 50_000)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 50_000)];

    const findings = ttlDrift(before, after, 100_000);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("manifest-declares-unextended");
    expect(findings[0]?.detail).toContain("50000");
  });

  it("does not report a key that was below threshold and did move", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 50_000)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 500_000)];
    expect(ttlDrift(before, after, 100_000)).toEqual([]);
  });

  it("reports an archived key that stayed archived", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 0)];
    const after = [reading(key, "Vec[Symbol(Balance)]", 0)];
    expect(ttlDrift(before, after, 100_000)).toHaveLength(1);
  });

  it("ignores a key missing from the after-reading", () => {
    const key = symbolKey("Balance");
    const before = [reading(key, "Vec[Symbol(Balance)]", 50_000)];
    expect(ttlDrift(before, [], 100_000)).toEqual([]);
  });

  it("judges each key against the threshold independently", () => {
    const low = symbolKey("Low");
    const high = symbolKey("High");
    const before = [reading(low, "Vec[Symbol(Low)]", 10_000), reading(high, "Vec[Symbol(High)]", 400_000)];
    const after = [reading(low, "Vec[Symbol(Low)]", 10_000), reading(high, "Vec[Symbol(High)]", 400_000)];

    const findings = ttlDrift(before, after, 100_000);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toBe("Vec[Symbol(Low)]");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/drift.test.ts`
Expected: FAIL — cannot resolve `../src/keeper/drift.js`.

- [ ] **Step 3: Write `src/keeper/drift.ts`**

```ts
import { xdr } from "@stellar/stellar-sdk";
import { describeScVal, keyId } from "../rpc/keys.js";
import type { TtlReading } from "../rpc/ttl.js";

/**
 * The two ways a published manifest can disagree with a compiled contract.
 *
 * `manifest-declares-unextended` — the manifest lists a key the contract does not
 * extend. A keeper watching that key is watching something nothing maintains.
 *
 * `manifest-omits-extended` — the contract extends a key the manifest never
 * declared. A keeper scanning only the manifest is blind to it.
 */
export type DriftKind = "manifest-declares-unextended" | "manifest-omits-extended";

/** One disagreement, ready to log. */
export interface DriftFinding {
  kind: DriftKind;
  keyId: string;
  description: string;
  detail: string;
}

function describeKey(key: xdr.LedgerKey): string {
  return key.switch().name === "contractData"
    ? describeScVal(key.contractData().key())
    : key.switch().name;
}

/**
 * Compare the published manifest against the contract's real footprint.
 *
 * The footprint comes from simulating `extend_all`, so it is the set of ledger
 * keys the compiled contract actually touches. This costs no fee, needs no
 * submission, and runs on every tick regardless of how healthy the contract is —
 * which is why it is the primary drift signal rather than the TTL diff below.
 */
export function footprintDrift(
  manifestKeys: xdr.LedgerKey[],
  footprintKeys: xdr.LedgerKey[],
): DriftFinding[] {
  const manifest = new Map(manifestKeys.map((key) => [keyId(key), key]));
  const footprint = new Map(footprintKeys.map((key) => [keyId(key), key]));
  const findings: DriftFinding[] = [];

  for (const [id, key] of manifest) {
    if (!footprint.has(id)) {
      findings.push({
        kind: "manifest-declares-unextended",
        keyId: id,
        description: describeKey(key),
        detail: "declared in the registry manifest but absent from the extend_all footprint",
      });
    }
  }

  for (const [id, key] of footprint) {
    if (!manifest.has(id)) {
      findings.push({
        kind: "manifest-omits-extended",
        keyId: id,
        description: describeKey(key),
        detail: "extended by the contract but absent from the registry manifest",
      });
    }
  }

  return findings;
}

/**
 * Confirm drift from observed time-to-live, after a real `extend_all` landed.
 *
 * Only keys that were **below the threshold** beforehand are judged. Soroban's
 * `extend_ttl` is conditional and does nothing when an entry is already above the
 * threshold, so a healthy key that did not move is behaving correctly. Judging
 * every key here would report drift on nearly every tick of a healthy daemon.
 */
export function ttlDrift(
  before: TtlReading[],
  after: TtlReading[],
  threshold: number,
): DriftFinding[] {
  const afterById = new Map(after.map((reading) => [reading.keyId, reading]));
  const findings: DriftFinding[] = [];

  for (const previous of before) {
    // Above threshold: the contract was under no obligation to touch this.
    if (previous.remaining >= threshold) continue;

    const current = afterById.get(previous.keyId);
    if (current === undefined) continue;
    if (current.remaining > previous.remaining) continue;

    findings.push({
      kind: "manifest-declares-unextended",
      keyId: previous.keyId,
      description: previous.description,
      detail:
        `was below threshold ${threshold} at ${previous.remaining} ledgers and did not ` +
        `increase after a successful extend_all (now ${current.remaining})`,
    });
  }

  return findings;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/drift.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run everything**

Run: `npm run build && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 6: Commit implementation and test separately**

```bash
git add src/keeper/drift.ts
git commit -m "feat(keeper): add footprint and threshold-gated drift detection"
git push origin main

git add test/drift.test.ts
git commit -m "test(keeper): drift findings from footprint and TTL diff"
git push origin main
```

---

### Task 13: `lkeep scan`

**Files:**
- Create: `src/commands/scan.ts`

**Interfaces:**
- Consumes: `loadConfig`, `makeServer`, `discoverAll`, `manifestLedgerKeys`, `instanceLedgerKey`, `readTtl`, `effectiveThreshold`, `log`
- Produces: `runScan(contractId: string): Promise<number>` — resolves to the process exit code

Exit 0 when every key is ok, exit 2 when any is low or archived, so the command works
as a shell check. Read-only. Never loads a keypair.

- [ ] **Step 1: Write `src/commands/scan.ts`**

```ts
import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { makeServer } from "../rpc/client.js";
import { instanceLedgerKey, manifestLedgerKeys } from "../rpc/keys.js";
import { readTtl } from "../rpc/ttl.js";
import { discoverAll } from "../registry/discover.js";
import { effectiveThreshold } from "../keeper/policy.js";

/**
 * Read one contract's TTL and report it.
 *
 * If the contract is registered, its whole manifest is scanned against its own
 * registered threshold. If it is not, only the instance entry is scanned, against
 * `LK_THRESHOLD`. Signs nothing and never reads the keeper key.
 *
 * Returns the exit code: 0 when every key is ok, 2 when any is low or archived.
 */
export async function runScan(contractId: string): Promise<number> {
  const config = loadConfig();
  const server = makeServer(config.rpcUrl);

  const entries = await discoverAll(server, config.registryId);
  const entry = entries.find((candidate) => candidate.contract === contractId);

  const threshold = entry
    ? effectiveThreshold(entry.threshold, config.threshold)
    : config.threshold;
  const keys = entry
    ? manifestLedgerKeys(contractId, entry.keysXdr)
    : [instanceLedgerKey(contractId)];

  const { readings, latestLedger } = await readTtl(server, keys, threshold);

  log.info("scanned contract", {
    contract: contractId,
    registered: entry !== undefined,
    threshold,
    latestLedger,
    keys: readings.length,
  });

  for (const reading of readings) {
    const fields = {
      contract: contractId,
      key: reading.description,
      durability: reading.durability,
      liveUntilLedgerSeq: reading.liveUntilLedgerSeq,
      remaining: reading.remaining,
      status: reading.status,
    };
    if (reading.status === "ok") {
      log.info("key ok", fields);
    } else if (reading.status === "low") {
      log.warn("key low", fields);
    } else {
      log.warn("key archived", {
        ...fields,
        note: "the next extend_all restores this automatically under Protocol 23",
      });
    }
  }

  if (!entry) {
    log.info("contract is not in the registry", {
      contract: contractId,
      note: "scanned the instance entry only; register it to scan its full manifest",
    });
  }

  return readings.some((reading) => reading.status !== "ok") ? 2 : 0;
}
```

- [ ] **Step 2: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/commands/scan.ts
git commit -m "feat(commands): add scan"
git push origin main
```

---

### Task 14: `lkeep extend`

**Files:**
- Create: `src/commands/extend.ts`

**Interfaces:**
- Consumes: `loadConfig`, `loadKeypair`, `makeServer`, `instanceLedgerKey`, `parseScValFromHexOrBase64`, `contractDataKey`, `extendViaContract`, `extendViaFootprint`, `log`
- Produces: `interface ExtendOptions { footprint: boolean; key: string[]; durability: "persistent" | "temporary" }`, `runExtend(contractId: string, options: ExtendOptions): Promise<number>`

Path A is the default. `--footprint` is the only way to reach Path B. There is no
fallback between them in either direction: they have different economic meaning and
the operator chooses.

- [ ] **Step 1: Write `src/commands/extend.ts`**

```ts
import { xdr } from "@stellar/stellar-sdk";
import { loadConfig, loadKeypair } from "../config.js";
import { log } from "../log.js";
import { makeServer } from "../rpc/client.js";
import { contractDataKey, instanceLedgerKey, parseScValFromHexOrBase64 } from "../rpc/keys.js";
import { extendViaContract } from "../ops/extendViaContract.js";
import { extendViaFootprint } from "../ops/extendViaFootprint.js";

export interface ExtendOptions {
  footprint: boolean;
  key: string[];
  durability: "persistent" | "temporary";
}

/**
 * Extend one contract's TTL.
 *
 * Default is Path A: call the contract's own permissionless `extend_all`, which
 * records maintenance in `lk_state` and makes the keeper eligible for a tip.
 * `--footprint` selects Path B instead: a raw `extendFootprintTtl` against
 * specific ledger keys, which works on any contract but records nothing and earns
 * nothing.
 *
 * Returns the exit code.
 */
export async function runExtend(contractId: string, options: ExtendOptions): Promise<number> {
  const config = loadConfig();
  const server = makeServer(config.rpcUrl);
  const keypair = loadKeypair(config);

  if (options.footprint) {
    const durability =
      options.durability === "temporary"
        ? xdr.ContractDataDurability.temporary()
        : xdr.ContractDataDurability.persistent();

    const keys = [
      instanceLedgerKey(contractId),
      ...options.key.map((raw) =>
        contractDataKey(contractId, parseScValFromHexOrBase64(raw), durability),
      ),
    ];

    log.info("extending via raw footprint", {
      contract: contractId,
      path: "B",
      keys: keys.length,
      extendTo: config.extendTo,
      note: "this records no maintenance and earns no tip",
    });

    const result = await extendViaFootprint({
      server,
      networkPassphrase: config.networkPassphrase,
      keypair,
      keys,
      extendTo: config.extendTo,
    });

    log.info("extended", {
      contract: contractId,
      path: "B",
      hash: result.hash,
      minResourceFee: result.minResourceFee,
    });
    return 0;
  }

  log.info("extending via contract extend_all", { contract: contractId, path: "A" });

  const result = await extendViaContract({
    server,
    networkPassphrase: config.networkPassphrase,
    contractId,
    keypair,
  });

  log.info("extended", {
    contract: contractId,
    path: "A",
    hash: result.hash,
    minResourceFee: result.minResourceFee,
    footprintKeys: result.footprint.length,
  });
  return 0;
}
```

- [ ] **Step 2: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/commands/extend.ts
git commit -m "feat(commands): add extend with Path A default and --footprint flag"
git push origin main
```

---

### Task 15: `lkeep registry-list`

**Files:**
- Create: `src/commands/registryList.ts`

**Interfaces:**
- Consumes: `loadConfig`, `makeServer`, `discoverAll`, `effectiveThreshold`, `log`
- Produces: `runRegistryList(): Promise<number>`

Read-only. Needs no key.

- [ ] **Step 1: Write `src/commands/registryList.ts`**

```ts
import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { makeServer } from "../rpc/client.js";
import { discoverAll } from "../registry/discover.js";
import { effectiveThreshold } from "../keeper/policy.js";

/**
 * Print every contract registered in the registry.
 *
 * The registry self-registers in its own constructor, so it appears in this list.
 * Read-only; signs nothing and reads no key.
 */
export async function runRegistryList(): Promise<number> {
  const config = loadConfig();
  const server = makeServer(config.rpcUrl);

  const entries = await discoverAll(server, config.registryId);

  log.info("registry contents", {
    registry: config.registryId,
    count: entries.length,
  });

  for (const entry of entries) {
    log.info("registered contract", {
      contract: entry.contract,
      keyCount: entry.keysXdr.length,
      threshold: entry.threshold,
      effectiveThreshold: effectiveThreshold(entry.threshold, config.threshold),
      extendTo: entry.extendTo,
      registeredLedger: entry.registered,
      updatedLedger: entry.updated,
      isRegistryItself: entry.contract === config.registryId,
    });
  }

  return 0;
}
```

- [ ] **Step 2: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/commands/registryList.ts
git commit -m "feat(commands): add registry-list"
git push origin main
```

---

### Task 16: Daemon scan loop

**Files:**
- Create: `src/keeper/loop.ts`

**Interfaces:**
- Consumes: everything built so far
- Produces: `maintainContract(ctx, entry): Promise<void>`, `runTick(ctx): Promise<void>`, `runLoop(ctx, signal): Promise<void>`, `interface KeeperContext`

The daemon never exits because one contract failed. Every per-contract operation is
wrapped; a failure logs and the loop moves to the next contract.

- [ ] **Step 1: Write `src/keeper/loop.ts`**

```ts
import type { Keypair, rpc } from "@stellar/stellar-sdk";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { manifestLedgerKeys } from "../rpc/keys.js";
import { readTtl } from "../rpc/ttl.js";
import { discoverAll, type ManifestEntry } from "../registry/discover.js";
import { extendViaContract, simulateExtendAll } from "../ops/extendViaContract.js";
import { decideMaintenance, effectiveThreshold } from "./policy.js";
import { footprintDrift, ttlDrift } from "./drift.js";

/** Everything a tick needs, built once at daemon start. */
export interface KeeperContext {
  config: Config;
  server: rpc.Server;
  keypair: Keypair;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The least remaining life across a set of readings.
 *
 * Guards the empty case: `Math.min()` with no arguments returns `Infinity`, which
 * would serialize into a log line as `null` and read as though the contract had
 * no TTL problem at all.
 */
function lowest(readings: { remaining: number }[]): number {
  return readings.length === 0 ? 0 : Math.min(...readings.map((r) => r.remaining));
}

/**
 * Scan one contract, report drift, and extend it if it needs it.
 *
 * Ordering matters. Drift is checked by simulation first, because that costs
 * nothing and works whether or not the contract needs maintenance. The TTL diff
 * runs only after a real extension, since it has nothing to compare otherwise.
 */
export async function maintainContract(
  ctx: KeeperContext,
  entry: ManifestEntry,
): Promise<void> {
  const { config, server, keypair } = ctx;
  const contract = entry.contract;
  const threshold = effectiveThreshold(entry.threshold, config.threshold);
  const keys = manifestLedgerKeys(contract, entry.keysXdr);

  const { readings: before } = await readTtl(server, keys, threshold);

  // Primary drift signal: free, and independent of whether TTL is low.
  try {
    const { footprint } = await simulateExtendAll({
      server,
      networkPassphrase: config.networkPassphrase,
      contractId: contract,
      keeper: keypair.publicKey(),
    });
    for (const finding of footprintDrift(keys, footprint)) {
      log.warn("manifest drift", {
        contract,
        kind: finding.kind,
        key: finding.description,
        detail: finding.detail,
      });
    }
  } catch (cause) {
    log.error("drift simulation failed", { contract, error: errorMessage(cause) });
  }

  const decision = decideMaintenance(before, threshold);
  if (!decision.needed) {
    log.info("no maintenance needed", {
      contract,
      action: "skip",
      result: "ok",
      reason: decision.reason,
      remainingBefore: lowest(before),
    });
    return;
  }

  log.info("maintenance needed", {
    contract,
    action: "extend",
    reason: decision.reason,
    lowKeys: decision.lowKeys,
    archivedKeys: decision.archivedKeys,
  });

  let hash: string;
  try {
    const result = await extendViaContract({
      server,
      networkPassphrase: config.networkPassphrase,
      contractId: contract,
      keypair,
    });
    hash = result.hash;
  } catch (cause) {
    log.error("extend_all failed", {
      contract,
      action: "extend",
      result: "error",
      error: errorMessage(cause),
    });
    return;
  }

  const { readings: after } = await readTtl(server, keys, threshold);

  for (const finding of ttlDrift(before, after, threshold)) {
    log.warn("manifest drift", {
      contract,
      kind: finding.kind,
      key: finding.description,
      detail: finding.detail,
    });
  }

  log.info("maintained contract", {
    contract,
    action: "extend",
    result: "success",
    hash,
    remainingBefore: lowest(before),
    remainingAfter: lowest(after),
  });
}

/** One pass over every registered contract. */
export async function runTick(ctx: KeeperContext): Promise<void> {
  // Logged before discovery rather than after it. Discovery is a network round
  // trip that takes seconds, so a "tick start" printed only once it returns leaves
  // the tick's opening seconds silent. That gap is actively misleading: a SIGINT
  // arriving mid-discovery prints "stopping" before "tick start", which reads as
  // though the daemon began a whole new tick after being told to stop. It does not
  // — but an operator watching a funded keeper cannot tell that from the log.
  log.info("tick start", {});

  let entries: ManifestEntry[];
  try {
    entries = await discoverAll(ctx.server, ctx.config.registryId);
  } catch (cause) {
    log.error("registry discovery failed", { error: errorMessage(cause) });
    return;
  }

  log.info("registry discovered", { contracts: entries.length });

  for (const entry of entries) {
    try {
      await maintainContract(ctx, entry);
    } catch (cause) {
      // One contract must never take the daemon down.
      log.error("contract failed", {
        contract: entry.contract,
        result: "error",
        error: errorMessage(cause),
      });
    }
  }

  log.info("tick end", { contracts: entries.length });
}

/**
 * Run ticks until the signal aborts.
 *
 * The interval is a delay *between* ticks rather than a fixed-rate timer, so a
 * tick that runs longer than the interval cannot overlap the next one.
 */
export async function runLoop(ctx: KeeperContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await runTick(ctx);
    if (signal.aborted) break;

    // The abort listener has to come off on the timeout path too. `{ once: true }`
    // removes it only if the event actually fires, and in the common case it never
    // does — the tick simply times out. Without the explicit removal, every
    // completed tick leaves a listener attached for the life of the process:
    // measured at 200 retained listeners after 200 ticks, against 0 with it. This
    // is the one component built to run forever, so it is the one place where
    // unbounded growth cannot be shrugged off.
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ctx.config.scanIntervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  log.info("daemon stopped", {});
}
```

- [ ] **Step 2: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/keeper/loop.ts
git commit -m "feat(keeper): add scan loop"
git push origin main
```

---

### Task 17: `lkeep keep` and the entrypoint

**Files:**
- Create: `src/commands/keep.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `runLoop`, `runScan`, `runExtend`, `runRegistryList`, `loadConfig`, `loadKeypair`, `makeServer`, `log`
- Produces: the `lkeep` binary

- [ ] **Step 1: Write `src/commands/keep.ts`**

```ts
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
```

`keypair.publicKey()` is safe to log. It is the public address, not the seed.

- [ ] **Step 2: Write `src/index.ts`**

```ts
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
          throw new Error(`--durability must be persistent or temporary, got: ${options.durability}`);
        }
        if (!options.footprint && options.key.length > 0) {
          throw new Error("--key only applies with --footprint. Path A extends the contract's own declared keys.");
        }
        process.exitCode = await runExtend(contractId, {
          footprint: options.footprint,
          key: options.key,
          durability: options.durability,
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
```

- [ ] **Step 3: Verify the binary runs**

```bash
npm run build
node dist/index.js --help
node dist/index.js scan --help
```

Expected: help text for both. No config is loaded for `--help`, so this works with
an empty environment.

Then confirm the config error path is clean:

```bash
env -u LK_RPC_URL node dist/index.js registry-list
echo "exit=$?"
```

Expected: one JSON line at level `error` naming `LK_RPC_URL`, and `exit=1`.

- [ ] **Step 4: Run everything**

Run: `npm run build && npm run lint && npm run format:check && npm test`
Expected: all clean, 86 tests across 8 files. This task adds no tests, so that count
must not change.

- [ ] **Step 5: Commit**

```bash
git add src/commands/keep.ts src/index.ts
git commit -m "feat(commands): add keep daemon command"
git push origin main
```

---

### Task 18: Complete the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Replace `README.md`**

```markdown
# ledgerkeep-cli

Off-chain keeper for LedgerKeep. Scans Soroban contract storage TTL and extends it
before entries expire.

A Soroban contract cannot read the time-to-live of its own storage at runtime. It
can extend TTL and record that it did, but it cannot observe how close an entry is
to expiry. That observation is what this tool exists to do.

The on-chain half — the `maintainable` standard, the `registry`, and the
`rent_vault` — lives in [ledgerkeep-core](https://github.com/ledgerkeep/ledgerkeep-core).

## Install

```bash
npm install
npm run build
```

Requires Node 22 or newer.

## Configure

Copy `.env.example` and fill it in.

| Variable | Purpose | Example |
|---|---|---|
| `LK_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `LK_NETWORK_PASSPHRASE` | Network passphrase | `Test SDF Network ; September 2015` |
| `LK_REGISTRY_ID` | Deployed registry contract ID | `C...` |
| `LK_KEEPER_KEY` | **Path to a file** holding the keeper secret seed | `/home/you/.ledgerkeep/keeper.key` |
| `LK_THRESHOLD` | Extend when remaining ledgers fall below this | `100000` |
| `LK_EXTEND_TO` | Target TTL in ledgers | `500000` |
| `LK_SCAN_INTERVAL_MS` | Daemon scan period | `60000` |

`LK_KEEPER_KEY` is a path, never a key. No command accepts a secret as a flag, and
no secret is ever logged. Export one from `stellar-cli` and restrict it:

```bash
stellar keys secret alice > ~/.ledgerkeep/keeper.key
chmod 600 ~/.ledgerkeep/keeper.key
```

`scan` and `registry-list` are read-only and run without any key present.

## Commands

### `lkeep scan <contractId>`

Reads TTL for the contract's instance entry and, if it is registered, every key in
its manifest. Exits 0 when all keys are ok, 2 when any is low or archived, so it
works as a shell check.

```bash
lkeep scan CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6
```

### `lkeep extend <contractId>`

Extends one contract. Calls `extend_all` by default. `--footprint` switches to a
raw `extendFootprintTtl`, `--key <xdr>` adds ledger keys to it (repeatable, hex or
base64), and `--durability` selects persistent or temporary.

```bash
lkeep extend CASBZNG6...6NZ6
lkeep extend CASBZNG6...6NZ6 --footprint --key 00000014
```

### `lkeep registry-list`

Prints every registered contract with its key count, threshold, and extend-to. The
registry self-registers in its own constructor, so it appears in its own listing.

### `lkeep keep`

The daemon. Every `LK_SCAN_INTERVAL_MS` it discovers registered contracts, scans
each, reports drift, and extends any that have fallen below threshold. A single
contract's failure is logged; the daemon continues to the next and resumes on the
next tick.

## Path A and Path B

There are two ways to extend TTL and they are not interchangeable. The tool never
picks for you.

**Path A — `extend_all`.** For a contract that adopts the LedgerKeep standard, the
CLI calls its permissionless `extend_all(keeper)`. The contract extends its own
declared keys and writes `lk_state`. That record is what makes the keeper eligible
to claim a tip from a `rent_vault`. This is the default and the only path that
produces a claimable maintenance record.

**Path B — `extendFootprintTtl`.** For a contract that never adopted the standard,
the CLI extends arbitrary ledger keys directly. It works against any contract, but
it writes no `lk_state` and earns no tip.

The daemon uses Path A only. Path B is reachable only through the explicit
`--footprint` flag. Nothing falls back from one to the other, because they have
different economic meaning and the operator should be the one choosing.

## Manifest drift

A registry manifest is advisory. Nothing on-chain checks that a contract's
published `keys_xdr` matches the keys its compiled `impl_maintainable!` actually
extends. The two can disagree, and this tool reports it.

Detection runs two ways:

1. **Footprint diff.** Simulating `extend_all` reveals the exact ledger keys the
   compiled contract touches. Comparing that set against the manifest catches
   disagreement in both directions — declared-but-unextended, and
   extended-but-undeclared. It costs no fee and runs on every tick.
2. **TTL diff.** After a real extension, keys that were below threshold beforehand
   and did not move are reported. Keys already above threshold are not judged,
   because Soroban's `extend_ttl` is conditional and a healthy key is supposed to
   stay put.

Drift is reported, never repaired. Fixing it means republishing the manifest or
recompiling the contract, and both are the contract owner's decision.

## Logging

Every line is JSON: `{ ts, level, msg, ... }`. `info` marks actions, `warn` marks
drift and low TTL, `error` marks RPC and signing failures. Pipe it to `jq`.

```bash
lkeep keep | jq 'select(.level == "warn")'
```

## Out of scope

- **Manual restoration.** Since Protocol 23, archived persistent entries are
  restored automatically when they appear in a footprint during an
  `InvokeHostFunctionOp`. A scan reports an archived entry and the next `extend_all`
  restores it as a side effect. There is no `restore` command.
- **Claiming tips.** The CLI does not interact with `rent_vault`.
- **Repairing drift.** Reported, not fixed.

## License

Apache-2.0
```

- [ ] **Step 2: Verify formatting is clean**

Run: `npm run format:check && npm run lint && npm test`
Expected: all clean. If prettier reformats the README, run `npm run format` and
re-stage.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: complete README with commands, env table, and Path A vs B explanation"
git push origin main
```

---

## Final verification

- [ ] `npm run build` clean
- [ ] `npm run lint` clean
- [ ] `npm run format:check` clean
- [ ] `npm test` green — 86 tests across 8 files
- [ ] `git status --porcelain` empty
- [ ] `git log --oneline` shows every task's commits, all pushed, on top of the two
      doc commits (design spec, this plan) that precede Task 1. Do not assert an exact
      count: plan-fix and follow-up commits made during execution are expected.
- [ ] No commit message contains `Co-Authored-By` or a generated-with footer:
      `git log --format=%B | grep -ci "co-authored-by\|generated with"` prints `0`
- [ ] No secret appears anywhere: `git grep -nE "^S[A-Z2-7]{55}$"` finds nothing
- [ ] `grep -rn "console\." src/ --include=*.ts | grep -v "src/log.ts"` finds nothing
- [ ] `grep -rn ": any" src/` finds nothing

## Constraints checklist

- [ ] No silent fallback between Path A and Path B; the operator chooses.
- [ ] `extendFootprintTtl` / `extendTo` / `setResourceFee` used, never the old names.
- [ ] No manual restoration built; noted as out of scope in the README.
- [ ] No secret key in a flag, in source, in a log, or in output.
- [ ] `config.ts` validates every variable before a command runs.
- [ ] The daemon logs and continues on a single contract's failure.
- [ ] Drift is detected and reported, never fixed.
- [ ] No `any`, `strict` clean, no bare `console.log` outside `log.ts`.
- [ ] No `git add .` after Task 1; pushed after every commit.
- [ ] SDK import surface verified in Task 2 and any difference reported.

