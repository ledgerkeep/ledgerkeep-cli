# ledgerkeep-cli — design

Date: 2026-08-02
Status: approved

## 1. Purpose

`ledgerkeep-cli` is the off-chain half of LedgerKeep. The on-chain half — the
`maintainable` standard, the `registry`, and the `rent_vault` — lives in
`ledgerkeep-core`, is deployed to testnet, and is not modified by this work.

A Soroban contract cannot read the time-to-live of its own storage entries at
runtime. A contract can extend TTL and record that it did, but it cannot observe
how close an entry is to expiry. That observation is why this tool exists.

The CLI does three things:

1. **Scan** — read the current TTL of a contract's storage entries over RPC and
   report how many ledgers remain before each expires.
2. **Extend** — build, simulate, sign, and submit a transaction that extends a
   contract's TTL.
3. **Keep** — run as a daemon: discover contracts from the registry, scan each on
   a schedule, and extend any that have fallen below threshold.

## 2. The two extension paths

**Path A — call the contract's `extend_all`.** For a contract that adopts the
standard, the CLI invokes its permissionless `extend_all(keeper)` through
`InvokeHostFunctionOp`. The contract extends its own declared keys and writes
`lk_state`, which is what makes the keeper eligible to claim a tip from a
`rent_vault`. This is the primary path and the only one producing a claimable
maintenance record.

**Path B — raw `extendFootprintTtl`.** For a contract that has not adopted the
standard, the CLI extends arbitrary ledger keys directly. It builds the ledger key
from a contract address, an `ScVal`, and a durability, puts it in the read-only
footprint, and submits. It writes no `lk_state` and earns no tip. It exists so the
tool is useful against contracts that predate the standard.

The daemon uses Path A only. Path B is reachable only by an explicit `--footprint`
flag on `extend`. The CLI never falls back from A to B. The two have different
economic meaning and the operator chooses.

## 3. Facts verified against ledgerkeep-core

Read from the deployed source before writing this design.

**`impl_maintainable!` behavior** (`crates/maintainable/src/macros.rs`):

- `keeper.require_auth()` is the first statement.
- It extends the instance entry, then each inlined persistent key, with
  `extend_ttl(threshold, extend_to)`.
- `extend_ttl` is **conditional**. It writes only when remaining TTL is already
  below `threshold`. A comfortably-alive key does not move. This single fact
  drives the drift design in section 6.
- It writes `MaintenanceState { last_maintained, last_keeper }` and returns the
  current ledger sequence.
- Errors: `ExtendTooLarge` (301), `NotMaintained` (302).

**Durability.** The macro touches only `instance()` and `persistent()`. Contract
instance entries are themselves `ContractData` with persistent durability. Every
manifest key is therefore persistent. Temporary storage is never maintained.

**Registry interface** (`contracts/registry/src/lib.rs`):

- `count() -> u32`
- `page(start: u32, limit: u32) -> Vec<RegistryEntry>`, erroring `LimitTooLarge`
  above 50.
- `get(contract) -> Option<RegistryEntry>`
- `RegistryEntry { contract, keys_xdr: Vec<Bytes>, threshold, extend_to,
  registered, updated }`
- `keys_xdr` holds XDR-encoded `ScVal` and is never decoded on-chain. There are no
  per-key labels.
- The registry self-registers in its constructor, so it appears in its own
  listing and the daemon maintains it like any other contract.

**Manifest fixture.** `scripts/init_testnet.sh` in core hardcodes the escrow's
three manifest values. These are known-good XDR from the deployed system and are
the fixture for the decode tests:

- `00000014` — `ScVal::LedgerKeyContractInstance`
- `0000001000000001000000010000000f0000000742616c616e636500` — `Vec[Symbol("Balance")]`
- `0000001000000001000000010000000f0000000a4d696c6573746f6e65730000` — `Vec[Symbol("Milestones")]`

**Restoration.** Since Protocol 23, archived persistent entries are restored
automatically when they appear in a footprint during `InvokeHostFunctionOp`. No
manual `restoreFootprint` command is built. A scan reporting an archived entry
notes that the next Path A run restores it as a side effect. Out of MVP scope,
stated as such in the README.

## 4. SDK

`@stellar/stellar-sdk` pinned to `16.2.0`, the current release as of this date.

The import surface is verified against the installed package before any RPC code
is written, and any difference from the following is reported rather than worked
around:

- RPC types under `@stellar/stellar-sdk/rpc`.
- `Operation.extendFootprintTtl` with field `extendTo` — not the removed
  `bumpFootprintExpiration` / `ledgersToExpire`.
- `SorobanDataBuilder.setResourceFee` — not the removed `setRefundableFee`.
- `Operation.ExtendFootprintTTL` as the TS type name.

Ledger key construction, for both reading and Path B:

```ts
xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: Address.fromString(contractId).toScAddress(),
    key: someScVal,
    durability: xdr.ContractDataDurability.persistent(),
  }),
);
```

Reading TTL: `getLedgerEntries` returns entries carrying `liveUntilLedgerSeq`, and
the response carries `latestLedger`. Remaining life is
`liveUntilLedgerSeq - latestLedger`. At or below zero, or a missing
`liveUntilLedgerSeq`, means archived. `getContractData` is preferred for single
reads.

## 5. Module boundaries

```
src/
├── index.ts                    commander entrypoint
├── config.ts                   env loading and validation
├── log.ts                      structured JSON logging
├── rpc/
│   ├── client.ts               Server construction, network config
│   ├── ttl.ts                  TTL read, remaining-life computation
│   └── keys.ts                 ledger key construction, XDR helpers
├── ops/
│   ├── extendViaContract.ts    Path A
│   └── extendViaFootprint.ts   Path B
├── registry/
│   └── discover.ts             page the registry, decode entries
├── commands/
│   ├── scan.ts
│   ├── extend.ts
│   ├── keep.ts
│   └── registryList.ts
└── keeper/
    ├── loop.ts                 daemon scheduling
    ├── policy.ts               threshold logic
    └── drift.ts                drift detection
```

| Module | Takes | Returns | Depends on |
|---|---|---|---|
| `rpc/keys.ts` | contract id, `ScVal`, durability | `xdr.LedgerKey`; decodes manifest `Bytes` → `ScVal` → key | sdk only |
| `rpc/ttl.ts` | `Server`, `LedgerKey[]` | per-key `{ key, liveUntil, remaining, status }` plus `latestLedger` | `keys.ts` |
| `registry/discover.ts` | `Server`, registry id | decoded `RegistryEntry[]` | simulation, `keys.ts` |
| `ops/extendViaContract.ts` | contract id, keeper | tx hash and the simulation footprint | signer |
| `ops/extendViaFootprint.ts` | `LedgerKey[]`, `extendTo` | tx hash | signer |
| `keeper/policy.ts` | scan result, entry terms | whether maintenance is needed, and why | pure |
| `keeper/drift.ts` | manifest keys, footprint, TTL before/after | `DriftFinding[]` | pure |

`policy.ts` and `drift.ts` are pure functions over plain data, with no I/O. That is
what lets them be tested without a network. Drift lives in its own module rather
than inside `policy.ts` so the policy tests do not have to carry footprint
fixtures.

## 6. Drift detection

Drift is the case the core docs describe: the published manifest and the compiled
keys disagree. Nothing on-chain checks that `keys_xdr` matches what
`impl_maintainable!` actually extends. The CLI detects the disagreement. It reports
it and never tries to fix it.

Two mechanisms run.

### 6.1 Footprint diff — primary

Simulate `extend_all(keeper)`. Read `transactionData` off the simulation response
and collect every `ContractData` ledger key in the footprint whose contract
address matches the target, taking the union of `readOnly` and `readWrite`. Which
of the two a TTL extension lands in is not depended on.

That set is what the compiled contract actually touches. Diff it against the
decoded `keys_xdr`:

- in manifest, absent from footprint → `manifest-declares-unextended`
- in footprint, absent from manifest → `manifest-omits-extended`

This costs no fee, runs on every tick regardless of TTL, and catches drift in both
directions.

### 6.2 Threshold-gated TTL diff — confirming

After a successful Path A submission, compare remaining life before and after —
but judge only keys whose remaining life was **below the contract's registered
threshold** beforehand. Those are the only keys `extend_all` was obligated to
move.

A key above threshold that does not move is correct behavior, not drift. An
earlier version of this spec judged every key and would have reported healthy
contracts as drifted on nearly every tick, because the daemon fires when any one
key is low while the rest are typically fine.

Findings from both mechanisms are `warn` lines naming contract and key.

## 7. Configuration

| Variable | Purpose | Example |
|---|---|---|
| `LK_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `LK_NETWORK_PASSPHRASE` | Network passphrase | `Test SDF Network ; September 2015` |
| `LK_REGISTRY_ID` | Deployed registry contract ID | `C...` |
| `LK_KEEPER_KEY` | Path to a file holding the keeper secret seed | `/home/me/.lk/keeper.key` |
| `LK_THRESHOLD` | Extend when remaining ledgers fall below this | `100000` |
| `LK_EXTEND_TO` | Target TTL in ledgers | `500000` |
| `LK_SCAN_INTERVAL_MS` | Daemon scan period | `60000` |

`LK_RENT_VAULT_ID` is deliberately absent. No MVP command reads it and there is no
`claim` command in scope. It returns with the command that needs it.

`config.ts` validates every variable a command needs before that command runs, and
exits naming the missing or malformed variable.

Validation is split by need. `LK_KEEPER_KEY` is checked only for commands that
sign. A missing key file must not stop `scan` or `registry-list` from running.

## 8. Signing

`LK_KEEPER_KEY` is a filesystem path to a file containing one secret seed. Nothing
else is supported — no stellar-cli identity store, no seed phrases, no OS keychain.
The operator exports from stellar-cli once.

Rules:

- `config.ts` checks the file exists and is readable, and does not read it.
- The secret is read at the moment of signing, trimmed, passed to
  `Keypair.fromSecret`, and not stored on any long-lived object.
- No flag accepts a secret.
- The logger has no code path that can reach a `Keypair`.
- `.env.example` documents the path form only and holds no real value.

Path A needs no separate auth signature. `extend_all` calls
`keeper.require_auth()`, and source-account auth satisfies that when the keeper is
the transaction source. This is confirmed against a real simulation during
implementation rather than assumed.

## 9. Commands

### `lkeep scan <contractId>`

Read TTL for the contract's instance entry and, if the contract is registered,
each key in its manifest. Print a table: decoded key, durability, live-until
ledger, remaining ledgers, status (`ok` / `low` / `archived`).

The key column is a rendering of the decoded `ScVal` — `LedgerKeyContractInstance`,
`Vec[Symbol(Balance)]`. The registry carries no per-key labels, so no description
column is possible.

Exit 0 if all keys are ok, exit 2 if any is low or archived, so the command works
as a shell check. Read-only. Signs nothing. Needs no key.

### `lkeep extend <contractId>`

Extend one contract. Default is Path A. `--footprint` forces Path B against the
instance key plus any `--key <xdr>` values given, with a durability flag defaulting
to persistent. Simulate first, print the resource fee, then submit. On failure
print the specific RPC error, not a generic string. On success print the
transaction hash.

### `lkeep registry-list`

Page the registry through `count` and `page`, printing every registered contract,
its declared key count, threshold, and extend-to. Pages in chunks of at most 50.
Read-only. Needs no key.

### `lkeep keep`

The daemon. Every `LK_SCAN_INTERVAL_MS`:

1. Discover all registered contracts.
2. Scan each. Apply `policy.ts`: a contract needs maintenance if any declared
   key's remaining life is below its registered threshold, falling back to
   `LK_THRESHOLD` when the registered value is zero.
3. Run footprint drift detection on each contract.
4. For each contract needing maintenance, run Path A, then the threshold-gated
   TTL diff.
5. Log every action.

The daemon never exits because one contract failed. It logs, moves to the next,
and resumes on the next tick.

## 10. Read-only command mechanics

`count` and `page` are contract functions, so reading the registry means
simulation, not `getLedgerEntries`. Simulation needs a source `Account` but signs
and submits nothing. `scan` and `registry-list` build a local `Account` from a
public address with a placeholder sequence number and never touch
`LK_KEEPER_KEY`.

Two limits are respected by chunking: `page` caps `limit` at 50, and
`getLedgerEntries` caps keys per request.

## 11. Logging

Every line is JSON: `{ ts, level, msg, ...fields }`. No bare `console.log` outside
`log.ts`. Levels: `info` for actions, `warn` for drift and low TTL, `error` for RPC
and signing failures. Daemon action lines carry timestamp, contract, action,
result, remaining-before, and remaining-after.

## 12. Testing

All tests run offline.

| File | Covers |
|---|---|
| `keys.test.ts` | ledger key round-trip for the instance key and a persistent key |
| `ttl.test.ts` | remaining-life computation, archived detection, missing `liveUntilLedgerSeq` |
| `discover.test.ts` | decoding the three real `keys_xdr` fixtures from core's `init_testnet.sh` |
| `policy.test.ts` | maintenance decision from remaining life, zero-threshold fallback |
| `drift.test.ts` | both footprint directions; a key above threshold that did not move is **not** drift |

## 13. Stack

| Item | Value |
|---|---|
| Runtime | Node.js, `engines: >=22`, CI on 22 and 24 |
| Language | TypeScript 5.x, `strict: true` |
| Package manager | npm |
| CLI framework | `commander` |
| Stellar SDK | `@stellar/stellar-sdk` `16.2.0` |
| Test runner | `vitest` |
| Lint | `eslint` + `@typescript-eslint`, `prettier` |

`tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`target: ES2022`, `module: ES2022`. Module resolution is set to whichever of
`bundler` or `node16` resolves the SDK's exports cleanly, and the outcome is
reported.

The local machine runs Node v24.18.0, which is why CI covers 24 as well as the
22 LTS line named in the original brief.

## 14. Standards

- No `any`. Narrow from `unknown`. No non-null assertions except immediately after
  a checked throw.
- Every async call that can fail is wrapped, and errors surface the RPC message.
- No secret key printed, logged, or written.
- Ledger values are integers. No floats, no `parseFloat` over SDK strings.
- Named exports only. One responsibility per module.

## 15. Git

Repository: `git@github.com:ledgerkeep/ledgerkeep-cli.git`, public, same org as
core, separate repo from core. Branch `main`.

- Never `git add .` after the initial scaffold commit. Stage by path.
- One commit per logical unit, pushed immediately.
- Conventional commits. Scopes: `setup`, `rpc`, `ops`, `registry`, `commands`,
  `keeper`, `docs`, `ci`.
- No `Co-Authored-By` trailer and no generated-with footer, in either repo.
- `npm run build`, `npm run lint`, and `npm test` all clean before any commit
  touching logic.

## 16. Build sequence

26 commits, one per item, pushed immediately. The original brief had 24. Splitting
policy from drift detection adds one, and drift's own test adds another.

**Setup**
1. `chore(setup): scaffold package.json, tsconfig, eslint, prettier, gitignore`
2. `docs(setup): add README skeleton and .env.example`
3. `ci(setup): add build, lint, test workflow`

**RPC**
4. `chore(rpc): pin @stellar/stellar-sdk and verify import surface`
5. `feat(rpc): add Server client and network config`
6. `feat(rpc): add ledger key construction and XDR helpers`
7. `test(rpc): ledger key round-trip for instance and persistent keys`
8. `feat(rpc): add TTL read and remaining-life computation`
9. `test(rpc): remaining-life and archived-entry detection`

**Config**
10. `feat(setup): add env loading and validation`

**Ops**
11. `feat(ops): add Path B extendFootprintTtl builder with simulate and submit`
12. `feat(ops): add Path A extend_all invocation`
13. `test(ops): footprint construction for a known key`

**Registry**
14. `feat(registry): add discovery via count and page with entry decoding`
15. `test(registry): decode a registry entry fixture`

**Commands**
16. `feat(commands): add scan`
17. `feat(commands): add extend with Path A default and --footprint flag`
18. `feat(commands): add registry-list`
19. `feat(log): add structured JSON logger`

**Daemon**
20. `feat(keeper): add threshold policy`
21. `test(keeper): policy decides maintenance from remaining life`
22. `feat(keeper): add footprint and threshold-gated drift detection`
23. `test(keeper): drift findings from footprint and TTL diff`
24. `feat(keeper): add scan loop`
25. `feat(commands): add keep daemon command`

**Docs**
26. `docs: complete README with commands, env table, and Path A vs B explanation`

## 17. Out of scope

- Manual `restoreFootprint`. Protocol 23 auto-restores.
- Any `rent_vault` interaction, including claiming tips.
- Any modification to `ledgerkeep-core`.
- Fixing drift. The CLI reports it.
