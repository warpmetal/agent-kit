# Initial release notes

Initial public submission of the WarpMetal skills-only plugin. The plugin
guides Codex through live VPS discovery, unpaid order preparation, bounded x402
payment authorization, provisioning, renewal, server lifecycle management, and
optional Agent Runtime sandbox workflows using the official WarpMetal CLI.

The plugin does not include an MCP server or bundle CLI source. It targets the
reviewed `warpmetal` CLI v0.7.0 contract, including opaque merchant challenge
reconciliation, wallet-address funding guidance, and verified refill-email
availability. Reviewers can exercise read-only discovery and the unpaid
checkout boundary without spending funds. Any payment requires the exact live
terms, an external x402api Agent Wallet, and the confirmation or standing
authority described by the skill. Destructive server and sandbox operations
require exact confirmations.
