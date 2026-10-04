# Working on RADWALLET

Write short sentences. Use active voice. Give one instruction per sentence.

Read `CLAUDE.md` for architecture and invariants. Read `.claude/mastery.md`
for engineering notes. Read `STORE.md` for the release gate. Read
`research/RADBRO_RESEARCH.md` for visual source material.

This repository contains the wallet engine in `packages/core`, the Preact UI
in `apps/wallet`, and the MV3 shell in `apps/extension`. The Android shell is
in `apps/mobile`.

## Verification

Run these checks before reporting completion:

```bash
npm test
npx tsc -p apps/wallet/tsconfig.json
npm run build
npm run lint:firefox
npm run lint:source
```

Run the E2E suites that cover the change. Extension changes require
`npm run e2e:ext` and `npm run e2e:firefox`. Android changes also require
`npm run lint:android` and the relevant emulator checks. Read every result.
Report failures and verification gaps.

## Rules

- Keep telemetry, wallet servers, and wallet fee receivers out of the code.
- Keep network-service opt-ins and data disclosures intact.
- Keep simulation before transaction signing.
- Keep REFUSE and SIGN controls equal in size.
- Keep keys inside `apps/wallet/src/session.ts` and the background session.
- Use `apps/wallet/src/ext.ts` for browser APIs in wallet source.
- Use callback-style extension APIs for Firefox compatibility.
- Preserve the black, yellow, Courier, and Times visual style.
- Do not add dependencies without an explicit request.
- Verify unfamiliar chain and RPC behavior with disposable accounts.

## Build outputs

`docs/` and `design/app-shots/` contain committed outputs. Regenerate `docs/`
with the build. Never edit its generated files by hand. Inspect screenshots
for secrets before committing them.

The E2E scripts rebuild first. Run `node scripts/e2e/<suite>.cjs` directly
only after a fresh build. Chromium extension tests use Playwright's bundled
Chromium. System Chrome can ignore extension loading flags.

The extension manifest is the version and permission source of truth. The
build checks it against the root `package.json`. Edit token curation in
`chains.ts`. Regenerate `tokenlist.ts`. Preserve `batchSize: 16_384` in token
multicalls.

## Shared work

Other sessions can use the same tree. Stage explicit paths. Never use
`git add -A`. Preserve unrelated changes. Do not push without a request.

Use a sentence-case imperative commit subject. Explain why the change was
needed. Use Git trailers for constraints, tests, and known verification gaps.
Record reusable engineering facts in `.claude/mastery.md`.

Keep `source-files.json` aligned with reviewed files. Run `lint:source` after
builds and screenshot updates. Inspect content before updating a path or hash.
