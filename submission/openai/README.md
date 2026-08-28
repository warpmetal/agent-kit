# OpenAI public plugin submission

These repository materials are ready to copy into the OpenAI Platform plugin
submission portal for an initial skills-only WarpMetal submission after the
owner-controlled checks in `checklist.md` are complete.

Before submission, a WarpMetal organization owner must confirm country
availability, verify the WarpMetal business identity, and ensure the submitter
has `Apps Management: Write` permission. The final policy attestations and the
external `Submit for Review` action remain owner-controlled actions.

The portal upload should use the tested skill bundle at
`../../plugins/warpmetal/skills/warpmetal`. Do not upload CLI state, request
envelopes, payment artifacts, wallet data, SSH private keys, or reviewer-local
credentials.

Before opening the portal, run `npm run plugin:check`, the plugin-creator
validator, and the skill validator from the repository root. Recheck
`warpmetal health --json` immediately before purchase-flow review.
