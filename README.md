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

| Variable                | Purpose                                           | Example                               |
| ----------------------- | ------------------------------------------------- | ------------------------------------- |
| `LK_RPC_URL`            | Soroban RPC endpoint                              | `https://soroban-testnet.stellar.org` |
| `LK_NETWORK_PASSPHRASE` | Network passphrase                                | `Test SDF Network ; September 2015`   |
| `LK_REGISTRY_ID`        | Deployed registry contract ID                     | `C...`                                |
| `LK_KEEPER_KEY`         | **Path to a file** holding the keeper secret seed | `/home/you/.ledgerkeep/keeper.key`    |
| `LK_THRESHOLD`          | Extend when remaining ledgers fall below this     | `100000`                              |
| `LK_EXTEND_TO`          | Target TTL in ledgers                             | `500000`                              |
| `LK_SCAN_INTERVAL_MS`   | Daemon scan period                                | `60000`                               |

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
