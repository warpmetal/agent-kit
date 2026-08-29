# Submission checklist

## Repository and local validation

- [x] Plugin manifest passes the plugin-creator validator.
- [x] Bundled skill passes the skill validator.
- [x] Bundled skill matches the authoritative `skills/warpmetal` source.
- [x] Local repo marketplace is installed and the plugin is enabled in Codex.
- [ ] A new Codex task triggers the plugin for each starter prompt.
- [x] CLI version is `0.7.4` and the full suite passes on Node.js 20 and 22.
- [x] The public plugin remains skills-only; its automated test rejects bundled
  `bin/` or `src/` code and requires an exact copy of the reviewed skill.
- [x] The companion CLI changes for expired unsigned challenge replacement,
  Agent Wallet 0.2.5 managed wallet setup, sponsorship policy, exact
  asset-specific funding instructions, and
  verified refill notifications are covered by tests.
- [x] Live health reported `purchasingReady: true` on 2026-08-27.
- [ ] Recheck live health immediately before reviewer purchase-flow testing.

## Public listing

- [ ] WarpMetal name, descriptions, logo, and category are final.
- [x] Website, product, support, privacy, and terms URLs return HTTP 200.
- [ ] An authorized WarpMetal owner confirms those URLs and their public copy are final and accurate.
- [x] Starter prompts map to the catalog, unpaid-order, and Agent Runtime reviewer workflows.
- [ ] Country and region availability is approved by operations and legal.
- [ ] Initial release notes are final.

## OpenAI Platform owner actions

- [ ] The WarpMetal developer or business identity is verified in the publishing organization.
- [ ] The submitter has `Apps Management: Write` permission.
- [ ] A new `Skills only` plugin draft exists in the submission portal.
- [ ] The final skill bundle is uploaded and passes automated scanning.
- [ ] Six positive and three negative reviewer cases are entered.
- [ ] Policy attestations are reviewed by an authorized WarpMetal owner.
- [ ] The owner selects `Submit for Review`.

## After review

- [ ] Review feedback is tracked without changing CLI behavior unless separately approved.
- [ ] The approved version is published from the portal.
- [ ] The public listing is verified in Codex and ChatGPT supported surfaces.
