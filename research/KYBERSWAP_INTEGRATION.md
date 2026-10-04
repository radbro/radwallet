# KyberSwap integration receipt — 2026-09-06

RADSWAP compares the existing direct routes with KyberSwap on Ethereum (1)
and Robinhood (4663) after the user enables hosted quotes. Higher quoted
output wins; ties prefer the direct route. Gas is displayed during review
but is not subtracted from the comparison. Pool fees and price impact remain.

## Sources and measured support

- [Fee schedule](https://docs.kyberswap.com/kyberswap-solutions/fee-schedule):
  swaps have no Kyber protocol fee. The wallet requests no integrator or
  referral fee and rejects fee-bearing responses and calldata.
- [Networks](https://docs.kyberswap.com/getting-started/supported-exchanges-and-networks)
  and [EVM API](https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps):
  `/ethereum/api/v1/routes`, `/robinhood/api/v1/routes`, and the corresponding
  `/api/v1/route/build` endpoints work without an API key.
- Live Chromium requests from a localhost origin returned HTTP 200/code 0
  for GET quotes and POST builds on both networks, including CORS preflights.
  The returned `extraFee` amount, charge side and receiver were empty.
- Both return router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`.
  [Verified Ethereum source](https://sourcify.dev/server/v2/contract/1/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5?fields=abi,sources)
  and [verified Robinhood source](https://sourcify.dev/server/v2/contract/4663/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5?fields=abi,sources,runtimeMatch)
  expose the supported ABI. Robinhood is an exact runtime match and does
  **not** expose `swapGeneric`, although Ethereum does.
- Live adapter GET/build checks passed for native ETH to USDC on Ethereum
  and WETH to `0x94b53E072798E6cce65cF21f050d3CB9F2bFb058` on Robinhood.
  Native input had exact transaction value; ERC-20 input had zero ETH value.
- Live `eth_call` simulations of freshly built 0.001 ETH routes succeeded on
  Ethereum (USDC output) and Robinhood (WETH output), using a throwaway public
  address and a balance state override. No key, signature or broadcast was
  used; this verifies the deployed router call, not funded trade settlement.

## Boundaries that must remain

Hosted quotes are off by default. The SWAP and Privacy toggles explain that
the API sees pair, amount, wallet address and IP. The sole fetch entry point
checks opt-in, omits cookies and referrer, and supports cancellation/timeout.
Tor host discovery includes the API only when enabled.

The API supplies untrusted calldata. Decode it and bind the router, token
pair, exact input/value, signer recipient and accepted output floor. Reject
permits, fee fields, partial fills, burns, arbitrary router allowances and
unknown flags. Verified router flag `0x200` is inert; simple mode `0x20`
uses separately decoded first-pool amounts and must have no destination fee.

Build can recompute output one wei below GET. Request up to one basis point
less build slippage, then enforce the accepted minimum against the actual
calldata. Never lower the user's minimum just to accept a build response.

Review refreshes the quote, validates the build and simulates locally. REFUSE
and SIGN & SEND have equal space. The review expires after 60 seconds, and
pair, amount, slippage, network, account or opt-in changes invalidate it.
ERC-20 allowances are exact and must be confirmed before preparing the swap.

Pasted CAs use RPC metadata and remain scoped to the current signer/network.
They do not write `customTokens` before purchase. The background confirmation
queue persists candidates bound to the actual signer, and adds a token only
after a successful receipt includes a positive ERC-20 Transfer to that signer.
Reverted transactions, pending receipts and transfers elsewhere do not add it.

## Regressions

`npm test` includes adapter tampering/opt-in tests and the picker/receipt
boundary tests. `npm run e2e:swap` tests the built UI with intercepted RPC/API
responses, no keys and no real broadcast. Chrome, Firefox and PWA
suites remain required for changes to these shared wallet paths.

Completed against the integrated build: 212 core, 12 swap-boundary and 10
clipboard unit tests; wallet typecheck; all-target build; Firefox artifact
lint; privacy network gate; Chrome extension/chains; real Firefox; PWA and
the existing focused UI suites. The new swap fixture passed 16 scenarios,
including mock signing with the chosen CA and tracking metadata. The built
background fixture passed pending/restart/success, revert and wrong-recipient
cases. These fixtures intercept network/signing; they do not move funds.

Saved 372px screenshots show the actual built UI with fixture data:
`design/app-shots/17-swap-pasted-contract.png` and
`design/app-shots/18-swap-kyber-review.png`. The review has no horizontal
overflow, and both equally sized signing controls pass visibility/hit tests.
