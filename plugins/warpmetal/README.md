# WarpMetal plugin

This directory packages the existing WarpMetal Agent Skill for local testing
and public submission to the Plugins Directory shared by ChatGPT and Codex.

The plugin is skills-only. It does not replace or modify the `warpmetal` CLI.
The skill requires the official CLI at version 0.7.3 or newer and asks before
installing or upgrading software. All purchasing, credential handling, SSH,
payment, renewal, and server-management behavior remains in the separately
published CLI.

The authoritative skill source is `../../skills/warpmetal`. Keep the bundled
copy under `skills/warpmetal` byte-for-byte identical; the automated plugin
test enforces that boundary.
