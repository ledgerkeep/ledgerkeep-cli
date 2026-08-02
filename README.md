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
