#!/usr/bin/env bash
#
# Create the planned ledgerkeep-cli issues on GitHub in one run.
#
# Usage:
#   scripts/create_issues.sh [--dry-run] [--yes] [owner/repo]
#
# Defaults to the repository the current directory belongs to. Creates the
# labels it uses first, so a fresh repository does not need them set up by hand.
#
# This writes to a public issue tracker and there is no bulk undo. Run it with
# --dry-run first.

set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
REPO=""

usage() {
    echo "usage: $(basename "$0") [--dry-run] [--yes] [owner/repo]" >&2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --yes | -y) ASSUME_YES=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        -*)
            echo "error: unknown option $1" >&2
            usage
            exit 2
            ;;
        *) REPO="$1" ;;
    esac
    shift
done

# gh is only needed to create issues, and to resolve the repository when one was
# not given. A dry run with an explicit repository works without it, so the
# issue text can be reviewed anywhere.
if [ "$DRY_RUN" -eq 0 ] || [ -z "$REPO" ]; then
    if ! command -v gh >/dev/null 2>&1; then
        echo "error: the gh CLI is not on PATH." >&2
        exit 1
    fi

    if ! gh auth status >/dev/null 2>&1; then
        echo "error: gh is not authenticated. run 'gh auth login'." >&2
        exit 1
    fi

    if [ -z "$REPO" ]; then
        REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
    fi
fi

# label name -> "colour|description"
declare -A LABELS=(
    ["complexity: low"]="c2e0c6|An hour or two, no design decisions"
    ["complexity: medium"]="fef2c0|Half a day, some design judgement needed"
    ["complexity: high"]="f9d0c4|Multi-day, changes a public surface"
    ["type: feature"]="a2eeef|Adds behaviour that does not exist yet"
    ["type: bug"]="d73a4a|Existing behaviour is wrong"
    ["type: test"]="bfd4f2|Adds or fixes coverage"
    ["type: docs"]="0075ca|Documentation only"
    ["type: refactor"]="d4c5f9|Same behaviour, better shape"
    ["area: setup"]="5319e7|Build, lint, type-check and tooling config"
    ["area: rpc"]="5319e7|src/rpc"
    ["area: ops"]="5319e7|src/ops, the two signing paths"
    ["area: registry"]="5319e7|src/registry"
    ["area: keeper"]="5319e7|src/keeper, the daemon and its decisions"
    ["area: commands"]="5319e7|src/commands and the CLI entrypoint"
)

# Conventional-commit scope in the title -> area label suffix. The scopes are
# the ones CONTRIBUTING.md defines, so this stays a straight pass-through until
# a scope needs to map somewhere else.
scope_to_area() {
    case "$1" in
        *) echo "$1" ;;
    esac
}

CREATED=0

# issue <title> <complexity> <type>, body on stdin. The area label is derived
# from the scope in the title, so the two cannot drift apart.
issue() {
    local title="$1" complexity="$2" itype="$3"
    local body scope area
    body="$(cat)"

    # Every title here carries a scope. Fail loudly rather than deriving a
    # nonsense label from a title that forgot one.
    case "$title" in
        *\(*\):*) ;;
        *)
            echo "error: title has no (scope): $title" >&2
            exit 2
            ;;
    esac

    scope="${title#*\(}"
    scope="${scope%%\)*}"
    area="area: $(scope_to_area "$scope")"

    if [ -z "${LABELS[$area]+set}" ]; then
        echo "error: no label for $area (from: $title)" >&2
        exit 2
    fi

    CREATED=$((CREATED + 1))

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "────────────────────────────────────────────────────────"
        echo "$title"
        echo "labels: $complexity, $itype, $area"
        echo
        echo "$body"
        return
    fi

    echo "==> $title" >&2
    gh issue create \
        --repo "$REPO" \
        --title "$title" \
        --label "$complexity" \
        --label "$itype" \
        --label "$area" \
        --body "$body"
}

# Every issue body ends with this. The stack is the same across the repository.
STACK_TS=$(
    cat <<'EOF'
### Tech Stack

TypeScript 5.7 on Node 22+ (CI runs 22 and 24), ESM with `moduleResolution: "NodeNext"` — relative
imports need the `.js` extension. `@stellar/stellar-sdk` is pinned to an exact version; verify RPC
API shape against the installed copy, not against documentation. Tests are Vitest under `test/` and
run without a network. `npm run format:check`, `npm run lint`, `npm run build` and `npm test` must
all be clean.
EOF
)

if [ "$DRY_RUN" -eq 0 ]; then
    echo "About to create issues on $REPO." >&2
    if [ "$ASSUME_YES" -eq 0 ]; then
        read -r -p "Continue? [y/N] " reply
        case "$reply" in
            y | Y | yes | YES) ;;
            *)
                echo "aborted." >&2
                exit 1
                ;;
        esac
    fi

    echo "==> Ensuring labels exist" >&2
    for name in "${!LABELS[@]}"; do
        IFS='|' read -r colour description <<<"${LABELS[$name]}"
        gh label create "$name" \
            --repo "$REPO" \
            --color "$colour" \
            --description "$description" \
            --force >/dev/null
    done
fi

# ─────────────────────────────────── ops ────────────────────────────────────

issue "fix(ops): cap the resource fee both signing paths will accept" \
    "complexity: medium" "type: bug" <<EOF
### Summary

Neither \`extendViaContract\` nor \`extendViaFootprint\` puts a ceiling on what it will pay. Both take
\`minResourceFee\` from the simulation, hand the assembled transaction to \`sign\`, and submit. The
number is whatever the network says it will cost.

That is a real weakness rather than a theoretical one, because registration is permissionless.
Anyone can register a contract in the registry, and \`lkeep keep\` maintains every contract in it. A
contract written to be expensive to maintain gets maintained at whatever it costs, once per tick,
until the keeper's account is empty. The futility backoff added in \`src/keeper/futility.ts\` does not
help here: an expensive extension that genuinely moves TTL is productive by every measure the daemon
has, so the backoff never opens a window.

The mitigation documented in SECURITY.md today is "fund the keeper with only what you are willing
to lose in a day". That is advice, not a control.

### Acceptance Criteria

- [ ] A configurable ceiling — \`LK_MAX_FEE\` or similar — validated in \`src/config.ts\` alongside the
      existing integer fields, with a documented default.
- [ ] Both signing paths compare the simulated fee against it and refuse to sign when it is
      exceeded. The refusal is logged with the contract, the simulated fee, and the ceiling.
- [ ] Refusing is not an error that kills the daemon: \`runTick\` moves on to the next contract, the
      same way it handles a failed extension today.
- [ ] The ceiling is checked before \`sign\` is called, not after submission.
- [ ] Tests cover a fee under the ceiling, a fee over it, and a fee exactly at it.
- [ ] The README env table and the SECURITY.md known-limits section are updated; the limit stops
      being described as unmitigated.

$STACK_TS
EOF

issue "fix(ops): distinguish the two identical simulation-failure messages" \
    "complexity: low" "type: bug" <<EOF
### Summary

\`src/ops/extendViaContract.ts\` throws \`simulation of extend_all failed: \${sim.error}\` in two
different places — once in \`simulateExtendAll\`, which is the free drift probe that runs every tick,
and once in \`extendViaContract\`, which is the paid path just before signing.

An operator reading a log line cannot tell which one failed, and the two mean very different things.
A failure in the first costs nothing and only loses drift reporting. A failure in the second means
maintenance did not happen.

### Acceptance Criteria

- [ ] The two messages differ enough to identify the call site from a log line alone.
- [ ] The distinction is meaningful to an operator — which one failed and what it cost — not just a
      different string.
- [ ] The \`drift simulation failed\` log line in \`src/keeper/loop.ts\` still reads correctly with the
      new message.

$STACK_TS
EOF

issue "feat(ops): reject an oversized --key list before the network does" \
    "complexity: low" "type: feature" <<EOF
### Summary

\`extendViaFootprint\` guards the empty case but has no upper bound on the number of ledger keys in
one \`extendFootprintTtl\`. A long \`--key\` list is built into a transaction, simulated, and rejected
by the network for exceeding its resource limits.

The operator gets a network error describing resource usage instead of being told their key list is
too long. Note that \`src/rpc/ttl.ts\` already chunks reads at 100 keys per request, so the repository
has a precedent for bounding this locally rather than discovering the limit remotely.

### Acceptance Criteria

- [ ] A documented maximum, established by finding where the transaction actually stops being
      accepted rather than by picking a round number.
- [ ] Exceeding it fails locally with a message naming the count and the maximum, before any
      simulation or network call.
- [ ] The limit is stated in \`lkeep extend --help\` and in the README's \`--key\` description.
- [ ] A test covers the boundary: the maximum accepted, one over rejected.

$STACK_TS
EOF

issue "test(ops): cover the submission and polling guards in extendViaFootprint" \
    "complexity: medium" "type: test" <<EOF
### Summary

\`extendViaFootprint\` has four guards that only fire against a live network: the empty-key-list
refusal, the \`isSimulationRestore\` refusal, the \`status !== "PENDING"\` submission rejection, and the
\`status !== "SUCCESS"\` post-poll failure. Only the first is reachable from a unit test today.

\`test/futility.test.ts\` establishes the pattern this needs — a structural object cast to
\`rpc.Server\` that answers the calls under test and fails loudly on the ones that should not happen.
The guards it does not cover are precisely the ones that decide whether an operator learns *why* a
transaction failed.

The \`isSimulationRestore\` guard matters most. It exists because \`ExtendFootprintTTLOp\` cannot
restore an archived entry — unlike \`InvokeHostFunctionOp\`, which restores automatically since
Protocol 23 — so Path B must refuse rather than submit something that cannot work. Nothing currently
proves it refuses.

### Acceptance Criteria

- [ ] A fake server drives \`extendViaFootprint\` through each guard.
- [ ] The \`isSimulationRestore\` path asserts that no transaction was submitted, not just that it
      threw.
- [ ] The \`TRY_AGAIN_LATER\` and \`DUPLICATE\` submission statuses are covered, and the test asserts
      polling is never reached — the point of that guard is not burning the poll budget on a hash
      the network does not have.
- [ ] The \`FAILED\` poll outcome asserts the result code reaches the error message.
- [ ] Each test is verified by mutation: break the guard, confirm the test fails, restore it. Say in
      the pull request which mutations you ran.

$STACK_TS
EOF

# ────────────────────────────────── keeper ──────────────────────────────────

issue "feat(keeper): persist futility backoff across daemon restarts" \
    "complexity: medium" "type: feature" <<EOF
### Summary

\`FutilityTracker\` in \`src/keeper/futility.ts\` holds its state in a \`Map\` that dies with the
process. A restarted daemon retries every contract once before it can begin backing off again.

That was a deliberate choice — a restart is often itself the fix, and forgetting is the right
default — but it has a failure mode worth closing: a supervisor restarting a crash-looping daemon
defeats the protection entirely, and the contract that keeps costing money is paid for on every
restart.

### Acceptance Criteria

- [ ] Backoff state survives a restart, in a location the operator controls and can inspect or
      delete.
- [ ] A stale state file cannot wedge the daemon: state older than some documented age is discarded
      rather than trusted, so a contract fixed while the daemon was down is retried.
- [ ] The file holds no key material and no secret. It is contract IDs and counters.
- [ ] Losing, corrupting or deleting the file degrades to today's behaviour — retry once, then back
      off — rather than crashing.
- [ ] Tests cover a round trip, a corrupt file, an absent file, and an expired entry.
- [ ] SECURITY.md's "Futility backoff does not survive a restart" limit is updated or removed.

$STACK_TS
EOF

issue "feat(keeper): retry transient RPC failures on the read path" \
    "complexity: medium" "type: feature" <<EOF
### Summary

The public testnet RPC intermittently fails calls for accounts and contracts that exist. Measured
during release verification: \`getAccount\` returned \`Account not found\` three times in a row for a
funded, live account and then succeeded, all within eight seconds, and a \`scan\` on the registry
returned \`fetch failed\` and succeeded on an immediate retry. One \`lkeep extend --footprint\` run died
on it outright.

The daemon survives this — it logs, moves to the next contract, and picks the work up next tick — so
this is not a correctness bug. But a one-shot \`lkeep scan\` or \`lkeep extend\` exits non-zero on a
fault that clears in under a second, and a keeper skips a tick's worth of maintenance for the same
reason.

### Acceptance Criteria

- [ ] Read-path calls — \`getLedgerEntries\`, \`getAccount\`, \`simulateTransaction\`, registry paging —
      retry a small, documented number of times with backoff.
- [ ] **Submission is not retried.** \`sendTransaction\` and \`pollTransaction\` are left alone: a
      resubmission risks paying twice, and \`extendViaContract\` already refuses to poll a hash the
      network never queued.
- [ ] Retries are logged at \`warn\` with the attempt number, so a flapping endpoint is visible rather
      than hidden.
- [ ] Total time spent retrying is bounded, and cannot make one contract exceed the scan interval.
- [ ] An abort during a retry backoff stops promptly — \`ctx.signal\` is already threaded through
      \`runTick\` and must be honoured here too.
- [ ] Tests use a fake that fails N times then succeeds; assert the call count, not just the result.

$STACK_TS
EOF

issue "test(keeper): assert one contract's failure cannot stop a tick" \
    "complexity: low" "type: test" <<EOF
### Summary

\`runTick\` wraps each \`maintainContract\` call in a try/catch so that one contract's failure is
logged and the loop continues. This is the property that keeps a keeper maintaining twenty contracts
when the first one is broken, and nothing tests it.

It is also the property most likely to be destroyed by a well-meaning refactor. Moving the try/catch
outward, or letting an \`await\` escape it, turns one bad contract into a daemon that stops working
and gives no clear sign why.

### Acceptance Criteria

- [ ] A test runs a tick over several contracts where a middle one throws, and asserts every other
      contract was still maintained.
- [ ] The failure is asserted to have been logged with the failing contract's ID.
- [ ] A test covers the first contract failing and the last contract failing, since off-by-one
      handling differs at the ends.
- [ ] The existing abort behaviour is not broken: a tick aborted mid-loop still stops immediately
      and logs \`contractsMaintained\` and \`contractsRemaining\`.
- [ ] Verified by mutation: remove the try/catch, confirm the test fails.

$STACK_TS
EOF

issue "refactor(keeper): let decideMaintenance reuse the classify boundary" \
    "complexity: low" "type: refactor" <<EOF
### Summary

\`classify()\` in \`src/rpc/ttl.ts\` owns the rule for what counts as archived and what counts as low:
\`remaining <= 0\` is archived, \`remaining < threshold\` is low. \`decideMaintenance()\` in
\`src/keeper/policy.ts\` then re-implements the same two comparisons to sort readings into
\`archivedKeys\` and \`lowKeys\`.

One rule, encoded twice. Every \`TtlReading\` already carries the \`status\` that \`classify\` produced,
so the second copy is reading data it could have trusted. If the boundary ever moves, it moves in
one place and stays wrong in the other — and the boundary is load-bearing, because Soroban's
\`extend_ttl\` only writes when remaining life is *strictly below* the threshold.

### Acceptance Criteria

- [ ] \`decideMaintenance\` sorts on \`reading.status\` rather than re-deriving it from \`remaining\`.
- [ ] Behaviour is unchanged: the existing policy tests pass without modification.
- [ ] \`threshold\` stays in the decision's \`reason\` string, which is what makes a log line
      self-explanatory.
- [ ] Verified by mutation: change the boundary in \`classify\` and confirm the policy tests fail —
      proving there is now one place to change rather than two.

$STACK_TS
EOF

# ───────────────────────────────── rpc, registry ────────────────────────────

issue "test(rpc): drive readTtl's chunking loop past a single request" \
    "complexity: low" "type: test" <<EOF
### Summary

\`readTtl\` chunks its key list at \`MAX_KEYS_PER_REQUEST = 100\` because the RPC caps how many keys one
\`getLedgerEntries\` call accepts. No test has ever sent it more than a handful, and the live checks
run during development only ever sent three keys.

Termination is structurally obvious. What is untested is everything else the loop does: that every
chunk is requested, that entries from all chunks are collected rather than the last one winning,
that \`latestLedger\` is reconciled across responses, and that output order still matches the
requested order — which the scan table depends on.

### Acceptance Criteria

- [ ] A fake server records the keys of every \`getLedgerEntries\` call.
- [ ] A test with more than 100 keys asserts the number of calls and that the union of requested
      keys equals the input exactly, with no key sent twice.
- [ ] A test asserts readings come back in the requested order across a chunk boundary.
- [ ] A test covers chunks reporting different \`latestLedger\` values and asserts which one wins.
- [ ] A test covers exactly 100 keys — one full chunk, no second request.

$STACK_TS
EOF

issue "test(registry): drive discoverAll's paging loop with a fake server" \
    "complexity: low" "type: test" <<EOF
### Summary

\`discoverAll\` pages through the registry at \`PAGE_LIMIT = 50\` per call. It is covered only by a
live check against a registry holding a single entry, which returns on the first page and never
exercises the loop.

This is the same untested-loop shape as the \`readTtl\` chunking issue, and the two should be picked
up together — a fake server written for one is most of the fake server needed for the other.

The paging loop is worth pinning down because a bug in it is silent: a keeper that stops after the
first page maintains the first 50 contracts and never mentions the rest.

### Acceptance Criteria

- [ ] A fake server returns several pages and a test asserts every entry is discovered exactly once.
- [ ] A test covers a total that is an exact multiple of \`PAGE_LIMIT\`, the boundary where a naive
      loop either stops early or makes one empty request too many.
- [ ] A test covers an empty registry.
- [ ] A test asserts the loop terminates rather than paging forever when the registry reports a
      count that disagrees with what \`page\` returns.
- [ ] The \`bigint\` branch of \`requireNumber\` is covered, since \`count\` can decode either way.

$STACK_TS
EOF

# ─────────────────────────────── commands, setup ────────────────────────────

issue "fix(commands): make the scan status chain exhaustive" \
    "complexity: low" "type: bug" <<EOF
### Summary

\`runScan\` in \`src/commands/scan.ts\` logs a line per key with an \`if / else if / else\` over
\`reading.status\`: \`ok\`, then \`low\`, then everything else treated as archived.

Adding a fourth \`TtlStatus\` would compile cleanly and report the new status as "archived". A scan
that silently mislabels an entry is worse than one that fails to build, because the exit code is
what people wire into shell checks.

### Acceptance Criteria

- [ ] The chain is exhaustive over \`TtlStatus\`, so adding a variant fails the build rather than
      falling through.
- [ ] The exit-code contract is unchanged: 0 when everything is \`ok\`, 2 when anything is not.
- [ ] Verified by adding a fourth variant to \`TtlStatus\` locally and confirming \`npm run build\`
      fails. Say so in the pull request; revert before submitting.

$STACK_TS
EOF

issue "fix(setup): type-check the test directory" \
    "complexity: low" "type: bug" <<EOF
### Summary

\`tsconfig.json\` has \`"exclude": ["node_modules", "dist", "test"]\`, so \`npm run build\` never looks at
\`test/\`. A type error in a test file does not fail the build, and CI does not catch it either — the
tests run through Vitest, which transpiles without type-checking.

This was confirmed rather than assumed: planting \`const _bad: number = "definitely a string"\` in a
test file leaves \`npm run build\` completely clean.

Turning it on surfaces real errors that exist today. \`test/ttl.test.ts:59\` indexes \`keys[1]\`, which
is \`LedgerKey | undefined\` under \`noUncheckedIndexedAccess\` — the same rule the source is held to.

### Acceptance Criteria

- [ ] \`test/\` is type-checked under the same \`strict\` settings as \`src/\`, without emitting test
      files into \`dist/\`.
- [ ] The existing errors are fixed properly. Do not weaken \`noUncheckedIndexedAccess\`, and do not
      reach for \`any\` or a non-null assertion — both are lint errors in this repository.
- [ ] A deliberate type error in a test file fails \`npm run build\`. Verify it, then revert it.
- [ ] \`npm run build\` still produces exactly the same \`dist/\` contents as before.
- [ ] The CONTRIBUTING.md warning that \`test/\` is not type-checked is removed.

$STACK_TS
EOF

# ─────────────────────────────────────────────────────────────────────────────

echo >&2
if [ "$DRY_RUN" -eq 1 ]; then
    echo "dry run: $CREATED issues would be created on $REPO." >&2
else
    echo "created $CREATED issues on $REPO." >&2
fi
