# Wallet behavior review checklist

Check behavior against the words on the controls. Use disposable accounts.
Keep network and signing fixtures separate from funded-transaction evidence.

| Area | Required behavior |
|---|---|
| Send quantities | Reject unsupported decimal precision before encoding |
| Send preview | Discard stale responses after wallet, network, or input changes |
| Swap minimums | Preserve the accepted minimum in exact integer calldata |
| Gas display | Identify estimates and retain nonzero precision |
| Token approvals | Show exact quantity and spender with verified decimals |
| Auto-lock | Apply valid changes to the live timer |
| Disconnect | Update the session connection and emit the site event |
| Wallet backup | Explain seed and imported-key recovery separately |
| Copied secrets | Report explicit cleanup results and preserve newer content |
| NFT reads | Support pagination or a known-ID ownership check where available |

Regression coverage must include 0, 6, and 18 decimals, very large quantities,
one-wei values, delayed responses, failed clipboard access, and failed NFT reads.
Browser checks must include popup and docked layouts. A simulated preview is
not a confirmed transaction outcome.
