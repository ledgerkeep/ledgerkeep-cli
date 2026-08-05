# Contributing to ledgerkeep-cli

Thanks for taking a look. This document covers how to get the repository building, what a commit
has to look like, and what happens to a pull request.

Read [SECURITY.md](SECURITY.md) before reporting anything that looks like a vulnerability. Do not
open a public issue for one.

This tool signs and submits transactions. Read the key-handling rules under
[Code standards](#code-standards) before you touch anything on a signing path.

## Getting set up

Node 22 or newer. CI runs on 22 and 24, so a change that needs a feature newer than 22 will fail.

```bash
npm install
npm run build
```

`npm install` installs an exact `@stellar/stellar-sdk` — the version is pinned without a range,
because the SDK moves its RPC surface between minors and this repository verifies API shape against
the installed copy rather than against documentation.

Copy `.env.example` to `.env` and fill it in before running anything that talks to a network.
`scan` and `registry-list` are read-only and need no key. `LK_KEEPER_KEY` is a **path to a file**
holding a secret seed, never the seed itself.

## Building and testing

Before you push, all four of these must be clean:

```bash
npm run format:check
npm run lint
npm run build
npm test
```

CI runs exactly these, in this order, on Node 22 and Node 24.

`npm run format` writes the formatting fixes that `format:check` only reports. Prettier skips
`docs/` on purpose: it reflows prose in ways that churn the spec and the implementation plan, and
the plan is read line by line during execution.

Tests are [Vitest](https://vitest.dev) files under `test/`, one per module. They run without a
network — nothing in the suite makes an RPC call. Code that talks to a server is tested through a
structural fake, as in `test/futility.test.ts`, which stands up an object shaped like `rpc.Server`
and asserts on which calls it received.

Two things worth knowing before you add a test:

- **`test/` is not type-checked.** `tsconfig.json` excludes it, so `npm run build` will not catch a
  type error in a test file. This is a known gap with an open issue against it; until it closes, do
  not assume a green build means your test compiles under `strict`.
- **Relative imports need the `.js` extension**, including in tests. The package is
  `"type": "module"` with `moduleResolution: "NodeNext"`, so `../src/keeper/loop.js` is correct even
  though the file on disk is `loop.ts`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), `type(scope): description`.

- **Types:** `feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `ci`
- **Scopes:** `setup`, `rpc`, `ops`, `registry`, `commands`, `keeper`, `docs`, `ci`

The scope is the part of the repository the change belongs to, not the file you edited. A change to
`src/rpc/ttl.ts` is `rpc`; a change to `src/keeper/loop.ts` is `keeper`; a change to `tsconfig.json`
or the lint config is `setup`.

One logical unit per commit — one function, one type, one block of tests. A commit that adds a
function and its tests and also renames something unrelated should be two or three commits.

Stage files by path. Do not use `git add .`; it is how gitignored-but-not-yet-ignored artifacts and
half-finished work end up in history.

Every commit must build. Run `npm run build` before committing, and `npm test` before committing
anything that touches logic.

Examples from this repository's history:

```
feat(keeper): add drift detection by footprint and TTL diff
fix(keeper): stop paying for extensions that cannot help
fix(ops): report result codes when a submitted transaction fails
docs: complete README with commands, env table, and Path A vs B explanation
```

## Pull requests

Work happens on a branch and lands through a pull request. There are no direct pushes to `main`.

1. Fork, or branch if you have write access. Branch names are not enforced; `type/short-description`
   is what we use.
2. Make your changes as a series of scoped commits.
3. Confirm the four checks above pass locally.
4. Open a pull request. If it closes an issue, write `Closes #123` in the body.
5. CI must be green on both Node versions and the pull request must be approved before it merges.

Describe what changed and why. If you made a design decision that a reader might disagree with, say
what you decided and what the alternative was — that is more useful than a summary of the diff.

If your change touches a signing path, say in the pull request whether you ran it against testnet,
and include the transaction hash if you did. Simulation is not the same as submission, and the
difference has hidden real bugs in this repository before.

## Code standards

Some of these are enforced by the linter and the compiler. The rest are enforced by review.

**Keys and secrets.** These are not style preferences.

- No secret key is ever printed, logged, or written to disk by this tool.
- No command accepts a secret as a flag or an argument. `LK_KEEPER_KEY` is a path.
- Error messages may name the file path and the environment variable. Never the file's contents.
- Never commit a `.env`. Never put a real seed in a test, a fixture, or an example.
- `src/log.ts` redacts `Keypair` instances and byte views at any nesting depth before serializing.
  Do not route output around it.

**TypeScript.**

- `strict`, plus `noUncheckedIndexedAccess` and `noImplicitOverride`. No `any` — the lint rule is an
  error, not a warning. No non-null assertions.
- Named exports only. No default exports.
- No bare `console.*` outside `src/log.ts`. Everything else goes through `log`.
- Every exported function carries a doc comment saying what it does and why it exists. "Why" is the
  part that is worth writing; the signature already says what.

**Behaviour.**

- **Never fall back between Path A and Path B.** They have different economic meaning — Path A
  writes a maintenance record and can earn a tip, Path B cannot — so the operator chooses, and a
  failure on one never silently retries as the other.
- Drift is reported, never repaired. Fixing a drifted manifest means republishing it or recompiling
  the contract, and both belong to the contract owner.
- The daemon logs and continues when one contract fails. A single bad contract must never take down
  a keeper maintaining others.
- Do not spend where spending cannot help. The footprint from simulating `extend_all` is free; use
  it to decide before you build a transaction, not after you have paid for one.
- Validate configuration in `src/config.ts` before a command runs, not at the point of use.

One thing is structurally impossible in Soroban and no amount of review will let it through: a
contract cannot read its own entries' TTL at runtime. That constraint is the reason this tool
exists. If a change assumes a contract can check its own expiry, it is going in the wrong direction.

## Reporting bugs

Open an issue with the version or commit you are on, what you ran, what you expected, and what
happened. For on-chain behaviour, include the contract ID, the network, and the transaction hash —
those make a report reproducible in a way a description cannot.

Include the JSON log lines rather than a summary of them. Every line this tool writes is structured
and machine-readable, and the fields carry detail that a retelling drops.
