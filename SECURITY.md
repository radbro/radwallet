# Security policy

RADWALLET holds keys. This public source alpha has not completed an independent
third-party audit. Source publication does not approve a browser-store release.

## Supported versions

The current 0.10.x source and its Chrome and Firefox packages receive fixes.
The PWA and Android shell share the wallet engine. Older minor versions are
not supported. No browser-store release has been approved.

## Report a vulnerability

Do not report vulnerabilities in public issues. Use this repository's private
vulnerability reporting under **Security → Report a vulnerability**.
The publication checklist requires the maintainer to enable this service.

Include the version or commit, affected component, reproduction steps, and
expected impact. Use disposable wallets and a testnet or local fork for a
proof of concept. Do not use another person's funds.

The maintainer aims to acknowledge reports within seven days. Reports that
can expose keys or lose funds should receive a fix or mitigation plan within
30 days. Agree on disclosure timing before publication. Credit is optional.
There is no bug bounty programme.

## Scope

The wallet engine, UI, session boundary, provider scripts, Android shell,
build scripts, packages, and published artifacts are in scope.

Pay particular attention to these boundaries:

- Vault encryption must not leak plaintext secrets to storage or a page.
- Session recovery must not bypass authorization or auto-lock deadlines.
- Sites must not sign for an address outside their connection.
- Transaction signing must preserve simulation and preview checks.
- Allowance rewriting must use verified token decimals.
- Provider events must not disclose another origin's connection.
- Hosted swap calldata must retain the approved recipient, input, and minimum.

RPC-provider behavior, browser vulnerabilities, Android vulnerabilities, and
phishing that asks users to type secrets are outside this project's control.
RPC providers see queried addresses. Blockchain activity is public.

## Store gate

An independent security review of the vault, sessions, approvals, and stealth
module is required before store submission. See [STORE.md](STORE.md).

## Verify release packages

Use Node 22. Run `npm ci`, `npm run build`, and `npm run package`. The result
must match the published `release/SHASUMS`. CI rebuilds the packages and
compares their hashes. Compare downloaded ZIPs with the release hashes.
