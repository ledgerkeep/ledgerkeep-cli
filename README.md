<!-- Optional: replace with a banner image. Keep it plain — a wordmark, not a stock illustration. -->
<h1 align="center">LedgerKeep CLI</h1>
<p align="center">
  A command-line keeper for Soroban contract state. Watches time-to-live, extends it before entries expire.
</p>
<p align="center">
  <a href="https://github.com/ledgerkeep/ledgerkeep-cli/actions"><img alt="CI" src="https://github.com/ledgerkeep/ledgerkeep-cli/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License: Apache-2.0" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg">
  <img alt="Node 22 | 24" src="https://img.shields.io/badge/node-22_%7C_24-green">
</p>

---

## What this is

A Soroban contract cannot read the time-to-live of its own storage entries at runtime. It can extend its TTL and record that it did, but it cannot watch its own entries approach expiry. That observation has to happen off-chain.

`ledgerkeep-cli` is the tool that does it. It reads a contract's TTL over RPC, reports how many ledgers remain before each entry expires, and extends any that are running low — one contract at a time, or continuously as a daemon that maintains everything registered in the [LedgerKeep registry](https://github.com/ledgerkeep/ledgerkeep-core).

This is the off-chain half of LedgerKeep. The standard, the registry, and the rent vault are on-chain in [`ledgerkeep-core`](https://github.com/ledgerkeep/ledgerkeep-core).

## Two ways to extend TTL

The tool extends TTL two ways, and the difference matters.

**Path A — call the contract's `extend_all`.** For a contract that adopts the LedgerKeep standard, the CLI invokes its permissionless `extend_all` function. The contract extends its own declared keys and records the maintenance on-chain, which is what makes a keeper eligible to claim a tip from that contract's rent vault. This is the primary path.

**Path B — raw `extendFootprintTtl`.** For a contract that has not adopted the standard, the CLI extends its ledger keys directly. This works on any contract, but records no maintenance and earns no tip. It exists so the tool is useful against contracts that predate the standard.

The daemon uses Path A for registered contracts. Path B is a manual command for everything else. The tool never silently switches between them — they mean different things, and the operator chooses.

## Commands

```
lkeep scan <contractId>       read TTL for a contract's keys, report remaining ledgers
lkeep extend <contractId>     extend one contract (Path A; --footprint forces Path B)
lkeep registry-list           list every contract registered for maintenance
lkeep keep                    run continuously: discover, scan, extend on a schedule
```

`scan` and `registry-list` read only — they sign nothing and need no key. `extend` and `keep` sign and submit, and need a funded keeper key.

`scan` exits 0 when every key is healthy and 2 when any is low or archived, so it works as a shell check. Every line the tool writes is one JSON object, so `lkeep keep | jq 'select(.level == "warn")'` gives you just the drift and the low-TTL warnings.

## Install

Requires Node.js 22 or newer. CI builds and tests on 22 and 24; those are the versions known to work.

```bash
git clone https://github.com/ledgerkeep/ledgerkeep-cli
cd ledgerkeep-cli
npm install
npm run build
npm link          # makes `lkeep` available on your PATH
```

## Configure

Copy `.env.example` to `.env` and fill it in.

| Variable                | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `LK_RPC_URL`            | Soroban RPC endpoint                          |
| `LK_NETWORK_PASSPHRASE` | Network passphrase                            |
| `LK_REGISTRY_ID`        | Deployed registry contract ID                 |
| `LK_KEEPER_KEY`         | Path to the keeper's signing key file         |
| `LK_THRESHOLD`          | Extend when remaining ledgers fall below this |
| `LK_EXTEND_TO`          | Target TTL in ledgers after extension         |
| `LK_SCAN_INTERVAL_MS`   | Daemon scan period                            |

`LK_KEEPER_KEY` is a path to a key file, never a secret on the command line. No command accepts a
seed as a flag or an argument. Read-only commands ignore it entirely.

The key is never printed, logged, or written — the logger redacts key material at any nesting depth
before it serializes anything. But be clear about the lifetime: `lkeep keep` reads the seed file
once at startup and holds the key in memory for as long as the daemon runs. Protect the file
accordingly (`chmod 600`, on a filesystem you control) and fund it only to what the keeper needs.

## Manifest drift

A contract publishes the storage keys it wants maintained to the registry. That manifest is
advisory: nothing on-chain forces it to match the keys the contract's compiled code actually
extends, and the two can disagree.

The CLI detects that two ways. Simulating `extend_all` reveals the exact keys the compiled contract
touches, which catches disagreement in both directions and costs no fee. After a real extension, any
key that was below threshold and did not move is reported. Both are reported, never repaired —
fixing drift means republishing the manifest or recompiling the contract, and both belong to the
contract owner.

Drift is also what stops the daemon wasting money. Before it spends, it checks that at least one key
below threshold is one the contract will actually extend; if none is, it skips rather than paying
for a transaction that cannot help. Where futility can only be seen after the fact, repeated
no-op extensions put that contract on an exponential backoff.

## What it costs

Real testnet figures from this release's verification, so the tradeoff is visible:

| Operation                                           | Fee charged |
| --------------------------------------------------- | ----------- |
| Path A — `extend_all`, 3 keys to ~500,000 ledgers   | ~1.92 XLM   |
| Path B — raw `extendFootprintTtl`, 1 key to 500,000 | ~0.0049 XLM |

Path A costs roughly 390× more here. It is an `InvokeHostFunctionOp`: it reads and runs the
contract's compiled code, writes the maintenance record, and pays rent on three entries instead of
one. Path B is a bare TTL bump on a single key and runs no contract code.

Neither number is a constant — fees scale with how many entries you extend, how large they are, and
how far you extend them. Treat these as one measured data point, not a price list. Note also that
neither transaction restored anything: all four entries were live when they were extended.

The comparison matters for one reason: a rent-vault tip has to exceed the Path A cost of the
contract it funds, or no keeper will run maintenance on it. Size vault tips against a measurement of
your own contract, not against this table.

## Deployments

Testnet. Verify each on the explorer before trusting it.

| Contract              | ID                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| registry              | `CB7K56KG3KHC43FROV534M55FMVGBW24NUFQSXSRMH7OS54242GFYMGN`                                                     |
| rent_vault            | `CACRDSINFHJFMH4ADZO3PA376VZQW7PXPWCZAFIFFEB5X4ZJLFJZMUTF` (listed for completeness; this tool never calls it) |
| long_escrow (example) | `CASBZNG6KRKZYRQ22TVOGEYSRDIV7QSCJDFIMSII5LA7XXKIUXOX6NZ6`                                                     |

> These come from `ledgerkeep-core`'s testnet deployment and exist so you can watch the tool work
> against something real. They were deployed by a throwaway identity that no longer exists, and
> testnet is periodically reset — verify before pointing your own keeper at them.

## Known limitations

Stated plainly, because they affect how you run this safely.

**No fee ceiling.** Registration in the on-chain registry is permissionless, and `lkeep keep` maintains every registered contract without a cap on what it will pay per extension. A contract registered specifically to be expensive to maintain will be maintained at whatever it costs, every tick, draining the keeper's balance. The futility backoff does not help here — an expensive extension that genuinely moves TTL looks productive by every signal the daemon has. **Do not run `lkeep keep` against a funded key you are not willing to expose to this** until a per-extension fee ceiling is in place. Single, scripted `extend` calls are not affected. This is the top open issue.

**Manual restoration is out of scope.** Since Protocol 23, archived persistent entries are restored automatically when they appear in a footprint during a contract call. The CLI does not implement a manual restore command. If a scan reports an archived entry, the next Path A extension restores it as a side effect. Path B cannot do this — `extendFootprintTtl` restores nothing — so the CLI refuses a Path B extension that would need a restore rather than submitting something that cannot work.

**Public RPC is intermittently unreliable.** The public testnet RPC occasionally returns "Account not found" for a live, funded account. The daemon survives this — it logs, continues, and retries on the next tick. A one-shot `extend` exits non-zero and should be retried. For anything you care about, use a dedicated RPC endpoint.

## Contributing

Issues and pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commit conventions, and the gotchas that will bite a contributor on day one. See [SECURITY.md](SECURITY.md) for responsible disclosure.

This tool signs and submits transactions. You are responsible for the keys you point it at. It is unaudited — review it before running it against anything holding real value.

## Maintainers

| Name         | Role       | GitHub                                 | Contact     |
| ------------ | ---------- | -------------------------------------- | ----------- |
| Dillon Ofili | Maintainer | [@0dillon](https://github.com/0dillon) | dillonofili667@gmail.com |

## Contributors

<a href="https://github.com/ledgerkeep/ledgerkeep-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ledgerkeep/ledgerkeep-cli" />
</a>

## License

Apache-2.0. See [LICENSE](LICENSE).
