# WarpMetal Agent Kit

The official command-line client and portable Agent Skill for WarpMetal.

The CLI uses the public API at `https://api.warpmetal.com`, stores generated
WarpMetal credentials in a user-private state file, and never reads or stores
wallet private keys or SSH private-key contents. Version 0.2 adds the optional
Agent Runtime workflow for fixed-size, isolated sandboxes on one owner's VPS.

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
- WarpMetal applies key-only OpenSSH configuration on initial provisioning and
  every OS reload. Password and keyboard-interactive login are disabled; never
  request, store, or expect a VPS login password.
- The CLI accepts an externally produced x402 `PAYMENT-SIGNATURE` from a file.
  Wallet key management and signing remain outside this package.
- Destructive or state-changing commands require explicit confirmations and
  generate idempotency keys by default.
- Runtime bootstrap credentials remain memory-only. Signed supervisor bundles
  are checksum- and signature-verified before OpenSSH uploads them.
- Each agent gets a distinct SSH key forced into exactly one sandbox. Token-free
  connection profiles pin the VPS host key and contain no owner credential or
  private-key material.
- Sandboxes use the fixed runtime image and fixed sizes. Persistent is the
  default; temporary sandboxes require explicit confirmation and permanently
  delete their workspace after 15 minutes to 24 hours.

## Agent Runtime example

```sh
warpmetal runtime enable --server <serverId> --json
warpmetal runtime install \
  --server <serverId> \
  --identity ~/.ssh/warpmetal-owner \
  --ssh-user ubuntu \
  --confirm INSTALL \
  --wait \
  --json
warpmetal sandbox create \
  --server <serverId> \
  --name planner \
  --size small \
  --wait \
  --json
warpmetal sandbox access keygen \
  --output ~/.ssh/warpmetal-planner \
  --confirm GENERATE \
  --json
```

See `skills/warpmetal/references/runtime.md` for the complete lifecycle,
cleanup, access-grant, and strict host-key connection workflow.

## Release status

The initial development release is published at
`https://www.npmjs.com/package/warpmetal`. The source is publicly visible but
remains `UNLICENSED`; choose an explicit license before describing the project
as open source or inviting third-party reuse.
