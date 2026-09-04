# CLI v0.8.2

Clarifies that WarpMetal installs the owner SSH key for `root` on every
supported image. Owner shell examples and Agent Runtime installation guidance
now consistently use `root@<server-ip>` and `--ssh-user root` instead of
inferring a distribution-default account such as `ubuntu`. CLI behavior is
unchanged.

# CLI v0.8.1

Adds confirmed-first x402 payment handling for checkout and renewal. WarpMetal
now pins x402api Agent Wallet 0.2.9, stops exact-artifact submission once the
merchant confirms payment, persists monotonic confirmed/finalized evidence,
and continues fulfillment while the finalized receipt arrives asynchronously.
The matching skills-only plugin metadata advances to 0.1.6.

# CLI v0.8.0

Adds post-provision human notification setup with SSH-authorized, immediately
active recipients; up to five masked recipients per server; targeted removal;
event controls; and branded recipient-added advisories. Email verification is
no longer part of the current workflow. No plugin or CLI publication is part
of this source change.

# Initial release notes

Initial public submission of the WarpMetal skills-only plugin. The plugin
guides Codex through live VPS discovery, unpaid order preparation, bounded x402
payment authorization, provisioning, renewal, server lifecycle management, and
optional Agent Runtime sandbox workflows using the official WarpMetal CLI.

The plugin does not include an MCP server or bundle CLI source. It targets the
reviewed `warpmetal` CLI v0.8.1 contract, including x402api Agent Wallet 0.2.9
managed wallet setup, network-specific wallet creation, exact asset balance
and deficit reporting, platform-treasury sponsorship, automatic replacement of
expired unsigned merchant challenges, opaque challenge reconciliation,
wallet-address funding guidance, and refill-email availability.
Reviewers can exercise read-only discovery and the unpaid checkout boundary
without spending funds. Any payment requires the exact live terms, an external
x402api Agent Wallet, and the confirmation or standing authority described by
the skill. Destructive server and sandbox operations require exact
confirmations.
