# Wallet copy guidance

Use direct words for financial and security decisions. Keep the Radbro visual
style. Do not obscure permissions, quantities, or failure states with slang.

| Topic | Required wording |
|---|---|
| Swap fees | Zero added wallet fee; venue fees and gas still apply |
| Simulation | Preview through RPC; outcome can change before confirmation |
| RPC rotation | Endpoint assignments and failover; no anonymity promise |
| Stealth | Fresh receiving addresses; public transactions and announcements |
| Discovery | Additional assets can be found; provider coverage can miss assets |
| External services | Name the provider and the data it receives |
| Disconnect | Revoke the connection; a site can retain prior addresses |
| Seed import | Say import when the action does not create a new phrase |
| Imported keys | State that a seed phrase cannot restore them |
| Clipboard | Automatic cleanup is best effort; offer explicit clearing |
| Activity | Saved history is on-device; blockchain history is public |
| Submission | A hash means submitted, not confirmed |
| Allowance | Show the current limit, spender, and future-balance exposure |
| Slippage | A larger limit permits fewer output tokens |

Check current behavior before changing a claim. Preserve exact token decimals
and minimum outputs. Keep consequential controls explicit. Do not call fixture
or demo results live transaction evidence.
