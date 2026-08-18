# WarpMetal Agent Kit

The official command-line client and portable Agent Skill for WarpMetal.

The CLI uses the public API at `https://api.warpmetal.com`, stores generated
WarpMetal credentials in a user-private state file, and never reads or stores
wallet private keys or SSH private-key contents.

## Distribution

- Source and releases: `https://github.com/warpmetal/agent-kit`
- CLI: the unscoped public npm package `warpmetal`, exposing the `warpmetal`
  executable
- Skill: `skills/warpmetal` in the GitHub repository and bundled inside the
  npm package

Keeping the skill beside the CLI gives Codex, Claude, and other Agent
Skills-compatible tools one canonical set of safety instructions while the CLI
remains the stable executable API.

## Install

```sh
npm install --global warpmetal
warpmetal --help
```

Install the bundled skill for supported coding agents:

```sh
warpmetal agent install --target codex
warpmetal agent install --target claude
warpmetal agent install --target all
```

Use `--scope project` to install into the current repository instead of the
user-level agent directory.

The bundled `skills/warpmetal` directory follows the portable Agent Skills
layout. Agents that support that layout but use another installation path can
consume that directory directly; they do not need a different WarpMetal API
integration.

## First commands

```sh
warpmetal health
warpmetal catalog
warpmetal order prepare \
  --plan agent \
  --hostname codex-workspace \
  --os '<exact name from warpmetal catalog>' \
  --ssh-public-key-file ~/.ssh/id_ed25519.pub
```

Pass `--json` for structured, secret-redacted output. Use
`WARPMETAL_API_URL` for an alternate API origin and `WARPMETAL_HOME` for an
alternate state directory.

## Security boundary

- Order and access tokens are never printed; they are written to
  `${WARPMETAL_HOME:-~/.config/warpmetal}/state.json` with user-only
  permissions where the platform supports POSIX modes.
- The CLI passes an SSH private-key path directly to `ssh-keygen`; it never
  reads the private key.
- The CLI accepts an externally produced x402 `PAYMENT-SIGNATURE` from a file.
  Wallet key management and signing remain outside this package.
- Destructive or state-changing commands require explicit confirmations and
  generate idempotency keys by default.

## Publishing status

This package is an initial development release. Choose the public-source
license and replace `UNLICENSED` before publishing it to npm.
