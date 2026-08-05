# Security Policy

## This tool signs transactions and spends your money

**It is unaudited. Do not point it at a mainnet key holding funds you cannot afford to lose.**

No third party has reviewed this code. It has tests and it has been exercised on testnet, and
neither of those is an audit.

Two things follow from what this tool does, and you should understand both before running it:

**You are responsible for your own keys.** `LK_KEEPER_KEY` is a path to a file holding a secret
seed in plaintext. This tool reads that file, holds the key in memory for as long as the process
runs, and signs with it. It never prints, logs, or writes the key, and `src/log.ts` redacts key
material at any nesting depth before serializing — but none of that protects a seed file with the
wrong permissions, on a shared host, in a backup, or in a container image. `chmod 600` it, keep it
off any filesystem you do not control, and use a key funded with only what the keeper needs.

**The daemon spends without asking.** `lkeep keep` submits transactions on its own schedule, for
every contract in the registry, for as long as it runs. Registration is permissionless: anyone can
put a contract in the registry, and the daemon will maintain it. Read the known limits below before
leaving one running unattended.

## Reporting a vulnerability

Email **<CONTACT>**. Do not open a public issue.

Include whatever you have:

- What the problem is and which module it is in.
- The steps or the configuration that trigger it.
- What an attacker gets out of it — a key, a signature, spent funds, a wedged daemon.
- The JSON log lines, and the contract ID, network and transaction hash if you saw it on-chain.
- A test case, if you wrote one.

You will get an acknowledgement within 72 hours. Expect an assessment of whether the report is
valid within 7 days, and an estimate of when a fix will land if it is.

Please give us 90 days before publishing. If a fix ships sooner, we will say so and you are free to
publish then. If we go quiet on you, publish — silence from a maintainer is not a reason to sit on
a real vulnerability.

Reporters are credited in the release notes for the fix unless they ask not to be. There is no
bug bounty.

## Scope

**In scope** — anything in this repository that handles a key, decides to spend, or builds a
transaction:

- `src/config.ts` — key loading, and any path where a secret could reach output.
- `src/log.ts` — the redaction walk. A way to get key material into a log line is a real finding.
- `src/ops/` — both signing paths. Transaction construction, the simulation guards, the submission
  and polling guards, and anything that would make the tool sign something other than what it
  reported it was signing.
- `src/keeper/` — the spend decision. Anything that makes the daemon pay when it should not, or
  skip when it should not.
- `src/registry/` and `src/rpc/` — decoding data that arrives from an untrusted network. A
  malformed registry entry or RPC response that causes a crash, a wrong ledger key, or a bad spend
  decision is in scope.
- `src/index.ts` — argument handling, including anything that would let a secret be passed as a
  flag.
- The CI workflow, where a compromise would affect what gets published.

**Out of scope:**

- The Soroban runtime, `@stellar/stellar-sdk`, and the Stellar network itself. Report those to
  [Stellar](https://github.com/stellar/stellar-protocol/security).
- The on-chain contracts. They live in
  [ledgerkeep-core](https://github.com/ledgerkeep/ledgerkeep-core) and have their own policy.
- The testnet deployments named in the README. They are there so you can watch the tool work
  against something real, and they hold nothing worth attacking.
- Anything requiring an attacker who already has your seed file, your shell, or your RPC endpoint.
- Availability of a public RPC endpoint. The public testnet RPC intermittently returns
  `Account not found` for accounts that exist; the daemon logs it and continues by design.
- The known limits below, which are design decisions we have already documented.

## Known limits, already documented

**A hostile contract can make a keeper pay.** There is no ceiling on the resource fee this tool
will accept from a simulation. The registry is permissionless, and `lkeep keep` maintains every
contract in it, so a contract registered specifically to be expensive to maintain will be
maintained at whatever it costs. This is a real weakness rather than a theoretical one, it has an
open issue against it, and until that closes the mitigation is the one above: run the daemon with a
key funded only to what you are willing to lose in a day. Reports that make this worse than
described — a way to amplify the cost, or to make the fee ceiling ineffective once it exists — are
in scope and we want to hear about them.

The rest follow from a constraint in Soroban: **a contract cannot read its own entries' TTL at
runtime.** A contract can extend and record; it can never observe. That is why this tool exists.

**Maintenance cannot be proven necessary.** A keeper decides from off-chain observation. The
`rent_vault` in `ledgerkeep-core` verifies that maintenance happened and who did it, not that it
was needed. A keeper running on a schedule earns tips whether or not the work was required.

**Manifests can drift, and this tool reports drift rather than repairing it.** The `keys_xdr` a
contract publishes is advisory. Nothing on-chain forces it to match the keys the compiled
`impl_maintainable!` actually extends. This tool detects the disagreement by simulating `extend_all`
and by comparing observed TTLs, and it will refuse to pay for an extension that provably cannot
help — but repairing the manifest means republishing it or recompiling the contract, and both
belong to the contract owner. A keeper that silently "fixed" someone else's manifest would be the
bug.

**Path A and Path B never fall back to each other.** `extend_all` writes a maintenance record and
can earn a tip; a raw `extendFootprintTtl` does neither. A failure on one is reported, not retried
as the other. The operator chooses. A change that adds a fallback is a security change, not a
convenience one.

**Futility backoff does not survive a restart.** The daemon remembers which contracts wasted its
money in memory only, so a restarted or crash-looping daemon retries every contract once before
backing off again. That is deliberate — a restart is often itself the fix — but a supervisor
restarting a daemon in a tight loop defeats the protection.
