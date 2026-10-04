# Radbro Webring — Research Report

*Research compiled 2026-08-05 for the Radbro Privacy Wallet project — an open-source,
privacy-first EVM wallet (MetaMask competitor) that borrows the Radbro Webring
aesthetic and community ethos.*

---

## 1. Executive summary

**Radbro Webring** is an Ethereum-native NFT ecosystem and meme culture that grew out
of the Milady / Remilia Corporation orbit in early 2023. It is a "brother community"
to Remilia: where Remilia has Milady, Remilio, and Bonkler, the Radbro umbrella has
**Radbro** (the flagship 5,000-piece PFP collection), **Radcats**, **SchizoPosters**,
and **Radbro Satoshis Vision** (Bitcoin Ordinals), plus the **$RAD** token
("Radcoin"), the sudoswap-based **Radswap** AMM, and the **Radder** NFT launchpad.

The whole thing is wrapped in a deliberately nostalgic **Web 1.0 / GeoCities
"webring"** presentation: starfield tiled backgrounds, yellow system-font text on
black, spinning 3D GIFs, `31337` hit counters, "Award of Elegance" badges, a "Free
Microsoft Internet Explorer" button, under-construction GIFs, and literal
`← Prev | Next →` webring navigation linking sister sites (radbro.xyz ↔ radder.xyz ↔
schizoposters.xyz). The art itself is chibi 3D anime characters (Milady-lineage
faces) photobashed over anti-consumerist halftone collages (They-Live-style
CONSUME / OBEY / CONFORM billboards), with an unhinged shitpost-maximalist streak in
the derivative collections.

The voice is deadpan, self-aware, terminally online, and quietly technically
serious: *"A bunch of rad bros being rad. Just tell 'em to check the chain."* —
*"Founderless, unruggable, the most trusted chain in the world."* Underneath the
memes the team ships real infrastructure (custom AMM pools, a token-emission NFT
contract, and the RBRC-721 Bitcoin ordinals metaprotocol with a cross-chain bridge).

That combination — shitpost surface, sound engineering underneath, anti-corporate
sovereignty politics — is exactly the brand space our wallet wants to occupy.

---

## 2. Origins and cultural context

- **Lineage.** Radbro descends from the Remilia Corporation / Milady Maker meme
  complex. Remilia's **Viral Public License** (VPL) invited a "Cambrian explosion"
  of derivatives; Radbro Webring is one of the few that matured into a full parallel
  ecosystem rather than a one-off knockoff.
- **The mirror-of-mirrors reading.** A widely-cited community analysis (quoted on
  the Remilia wiki) frames the character chain as: Milady (original) → Pixelady
  (diminished reflection) → Remilio (boyish, libertarian inversion) → **Radbro
  (reflection of the inversion)** — "a man seen only in mirror images; lost in a
  hall of mirrors he is a reflection of a reflection… without a wider frame of
  reference he is nothing." The official site plays on this: **"Radbro was the
  redacted word in Remilio."**
- **Timeline.**
  - Feb 2023 — Radbro Webring V1 mints (5,000 ERC-721s on Ethereum).
  - 2023 — migration to the **V2 contract** ("WE HAVE MIGRATED TO A NEW CONTRACT!");
    V2 is the canonical collection today.
  - Mar 2023 — **SchizoPosters** (5,555 items, "created by Rivergod & 10x") launches
    in the webring.
  - 2023–24 — **Radcats** launches with Radswap AMM pools; Radcat **Nuigurumi**
    plushie redemptions (500 supply) offered.
  - Feb 2024 — **Bitcoin expansion**: Radbro Satoshis Vision, 5,000 Ordinals minted
    simultaneously on ETH and BTC via the custom **RBRC-721** metaprotocol; later
    Runes claims and the **Lasogette** ETH→BTC bridge.
  - Sep 2025 — Radbro is a recognized PFP option on RemiliaNET, Remilia's social
    network.
- **Reception.** Delphi Digital covered SchizoPosters in 2024 as "the NFT collection
  with the most momentum," explicitly situating the Radbro Webring as the parallel
  structure to the Remilia umbrella.

---

## 3. Ecosystem map

| Piece | What it is | Key facts / addresses |
|---|---|---|
| **Radbro Webring V2** (`RADBROS`) | Flagship 5,000 PFP collection, ERC-721 | `0xabcdb5710b88f456fed1e99025379e2969f29610` · metadata served from `radbro.xyz/api/tokens/metadata/{id}`, images on IPFS · "Radbros get $RAD" — the NFT contract doubles as a token emitter |
| **Radbro Webring V1** | Original Feb-2023 contract, superseded | `0xe83c9f09b0992e4a34faf125ed4fedd3407c4a23` |
| **$RAD / Radcoin** | ERC-20 ecosystem token, claimable by Radbro holders ("Claim Radcoin!!" on radbro.xyz/rad; per-Bro unclaimed balances are checkable by token ID) | `0xdDc6625FEcA10438857DD8660C021Cd1088806FB` |
| **Radcats** | Derivative cat collection, traded via Radswap | `0x3bFC3134645ebe0393F90d6a19BcB20bD732964F` · Nuigurumi plushie redemption (500) |
| **Radswap** | sudoswap-based AMM for NFT↔token swaps: Cats↔$RAD, Bros↔$RAD, ETH↔RAD, RAD↔BRO. Cart UI with slippage tolerance (default 1%) | Radcats pool `0xE283CE6F85f74261d8964f791F30daCBFBE93ea9` · Bros pool `0xD2236f0FC672B77d41cF4754858C1E3a9c44590D` · pool manager `0xd86ED727D774F5D61552bf92E1E23b08aF55e6aa` |
| **SchizoPosters** | 5,555-piece sister collection (Rivergod & 10x); "SCHIZODEX" on-site explorer with archetype taxonomy (Mechanized, Ice, Arboreals, Tulpas, Demons, The Greys, Robro…) and subtype counts (Radbro 1133, Milady 952, Oakbros…) | opensea.io/collection/schizoposters · schizoposters.xyz |
| **Radbro Satoshis Vision** | 5,000 Radbro Ordinals on Bitcoin, inscribed via RBRC-721; Rune claims; Lasogette bridge | bitcoin.radbro.xyz |
| **RBRC-721** | Home-grown Ordinals NFT metaprotocol: root/asset/NFT inscription hierarchy, recursive delegation to cut inscription cost, `rbrc721:[collection]:[type]:[key]=[value]` syntax, ETH-side contracts orchestrating mints with a RadBroOracle syncing both chains | radbro.substack.com |
| **Radder** | "A RAD-first NFT launchpad" — curated minting marketplace in partnership with Scatter (Rad Heroes, Spooky Nuigurumi, Remivision…) | radder.xyz |
| **CLUB** | "Fight it out" — wallet-gated section on radbro.xyz | radbro.xyz/club |
| **Socials** | X `@radbro_webring`, Discord, Substack (`radbro.substack.com`), OpenSea, Uniswap, DexScreener | — |

The **webring itself** is real navigation: every member site carries
`← Prev | Radbro Webring | Next →` links plus the shared footer ritual (webring
badges, hit counter, award GIF).

---

## 4. The aesthetic (the part we're stealing)

### 4.1 radbro.xyz — GeoCities sovereignty

Captured in `assets/screenshots/radbro-home.png` (+ bros/cats/rad/club):

- **Tiled starfield** background (purple/blue stars on black), the definitive 1999
  personal-homepage wallpaper.
- **Yellow default-serif headline text on black**; body copy also yellow. Links in
  red/white. Zero typographic sophistication — that's the point.
- **Spinning PS1-style 3D Radbro head GIFs** flanking the title, mirrored left/right.
- Centerpiece meme image: **`[RADBRO INTENSIFIES]`** — subtitle-meme format over a
  dithered anime still (the Radbro character gripping a strap, Lain-era framing).
- Tagline copy: *"The best and only place to get Radbro on the World Wide Web."* /
  *"Radbro was the redacted word in Remilio."*
- Nav is just text: **`CATS | BROS | $RAD | CLUB`** in huge yellow caps.
- A single plain **yellow `Connect Wallet` button** — the only "app" affordance on
  the page.
- Footer ritual: under-construction GIFs around "Radbro.xyz", a green-LCD
  **hit counter reading `31337`** (leetspeak "elite"), a framed **"Award of
  Elegance"** GIF, and a **"Free Microsoft Internet Explorer"** 88×31 badge.
- Rainbow-gradient `<hr>` separators.
- The swap UI (Radswap) lives *inside* this same page style: cart, pool listings,
  slippage input — DeFi mechanics dressed as a 1998 fan page.

### 4.2 bitcoin.radbro.xyz — 8-bit terminal

Captured in `assets/screenshots/radbro-sv-bitcoin.png`:

- Black + **pixel starfield with sparkle crosses**, pixel-art UFOs abducting pixel
  Radbros in the corners.
- **Everything monospace / pixel-font**, yellow-on-black; headings with yellow
  highlighter-block backgrounds (`THE COLLECTION`, `RBRC-721 METAPROTOCOL`).
- Hero: `[RADCAT INTENSIFIES]` video still (pixelated Radbro in a frog hat).
- Copy voice: *"To be inscribed immutably forever on that beautiful proof-of-work
  chain. Founderless, unruggable, the most trusted chain in the world."* and the
  collection description: *"A bunch of rad bros being rad. Just tell em to check
  the chain."*
- Big stat typography: `5000` / `Inscribed` / `Bitcoin` in chunky pixel type.
- Yellow pill buttons (`Buy a Radbro`, `Connect BTC Wallet`).

### 4.3 schizoposters.xyz — terminal schizocore

Captured in `assets/screenshots/schizoposters.png`:

- Pure black, **all-monospace terminal UI**; red accent on the reset button, purple
  `Connect Wallet`.
- Logo is a **CIA-seal parody** roundel ("SCHIZO POSTERS — CREATED BY RIVERGOD &
  10X" with an eagle over the compass-star crest).
- An embedded **audio player** (7:48 ambient track) at the top of the page.
- "SCHIZODEX V1" — a filterable index of all 5,555 items by archetype/subtype with
  counts, like a conspiracy database.
- The art: greyscale chibi faces buried in **walls of paranoid micro-text**, helmets,
  glitch textures; occasional full-color psychedelic pieces.
- Long scrolling **schizo manifesto** in monospace ("Something isn't right and I
  don't know what I should do… Nothing is eternal, save for the mist that shrouds
  me.") — lore delivered as creepypasta.
- Same webring footer ritual: badges, `31337` counter, Award of Elegance, IE badge.

### 4.4 radder.xyz — the "polished" one

Captured in `assets/screenshots/radder.png`: starfield again, but with rounded
**yellow-outlined cards**, a hero banner (painterly prairie scene with a chibi
Radbro), red pixel-sun logo, and `MINTING NOW` / `MINTED OUT` sections in bold
yellow caps. Shows how the brand scales up to a "real product" while keeping
yellow-on-black + starfield identity.

### 4.5 The NFT art itself

Samples in `assets/nft-samples/`:

- **Radbros** (`radbro-*.png`): chibi 3D-rendered anime boy — brown mop of hair, huge
  amber eyes, flat mouth — the Milady/Remilio facial lineage rendered as a smooth
  3D toy. Dressed in trait gear (tactical vests: "RAD.11 TACTICAL", NERF-brand
  spectacles, badge patches) and composited over **black-and-white halftone
  photo-collages of consumerist dystopia**: billboards reading CONSUME, OBEY,
  CONFORM, BUY (straight out of *They Live*), crowds, city canyons. A red graffiti
  `RADBRO` wordmark signs the corner. Trait names are in-jokes: Environment
  "Consume", Logo "rage", Shirt "nobody", Street "12 Steps", plus a paired
  `Remilio-XXXX` trait tying each Bro to a Remilio.
- **Radcats** (`radcat-*.png`): descriptor text is literally "RADCAT" ×18. The art is
  **shitpost-maximalist photobash**: a gorilla-headed cat with a skull face and red
  spiral eyes, a katana for a tail, surrounded by kei-vans with RADBRO livery, JoJo
  menace glyphs (ゴゴゴ) and manga-panel backdrops. Traits like "Zangetsu Massive",
  "Honda That's", "Crazy Feet", "Race Face", "Fallen Patriot". Absurdity as a
  feature, not a bug.
- **Site GIF art** (`assets/site-art/`): the spinning 3D head (`radbro3d.gif`), the
  `[RADBRO INTENSIFIES]` loop (`intensifies.gif`), collection montage GIFs, the
  gold-coin **Radcoin spinning GIF** (`radcoin.gif`), the Nuigurumi plushie render
  (`nuigurumi-hero.png`), an arcade-cabinet photo (`arcade.jpeg`), under-construction
  and award badges.

### 4.6 Voice & copywriting patterns

- Deadpan superlatives: "The best and only place to get Radbro on the World Wide Web."
- Chain-maximalist earnestness: "Just tell 'em to check the chain." /
  "Founderless, unruggable."
- Lore-as-redaction: "Radbro was the redacted word in Remilio."
- Meme-format titles: `[X INTENSIFIES]`, ALL-CAPS announcements with emoji on X,
  "RADCAT" repeated eighteen times as an NFT description.
- Sign-offs like *"Love, Radbro Webring"* on otherwise-technical protocol posts.
- Substack posts flip register completely: precise, competent protocol engineering
  (RBRC-721 inscription hierarchy, bridging guides) written for practitioners.

---

## 5. Asset inventory (this repo)

```
research/assets/
├── screenshots/          # Full-page captures, 1440px wide, Aug 2026
│   ├── radbro-home.png       # radbro.xyz — the canonical aesthetic reference
│   ├── radbro-bros.png       # Radswap BROS↔$RAD swap UI
│   ├── radbro-cats.png       # Radswap CATS↔$RAD swap UI
│   ├── radbro-rad.png        # $RAD claim/swap page
│   ├── radbro-club.png       # CLUB (wallet-gated)
│   ├── schizoposters.png     # SCHIZODEX terminal UI + manifesto
│   ├── radder.png            # Radder launchpad
│   ├── radbro-sv-bitcoin.png # Bitcoin/Ordinals site, pixel aesthetic
│   └── radbro-substack.png   # Official substack
├── site-art/             # Original site assets (radbro.xyz /images + badges)
│   ├── radbro3d.gif          # Spinning PS1-style head (logo)
│   ├── intensifies.gif       # [RADBRO INTENSIFIES] loop
│   ├── collection.gif        # Radbro collection montage
│   ├── radcats-collection.gif
│   ├── radcoin.gif           # Spinning gold $RAD coin
│   ├── nuigurumi-hero.png    # Plushie render
│   ├── arcade.jpeg
│   ├── construction.gif      # Under-construction (52×71)
│   ├── award-of-elegance.gif # Footer award badge
│   └── webring-badge-*.gif   # 88×31 webring badges
└── nft-samples/          # On-chain art fetched via tokenURI → IPFS
    ├── radbro-{1,777,1831}.png
    └── radcat-{7,2057}.png
```

Provenance: screenshots taken with headless Chromium; NFT images resolved from the
live V2/Radcats contracts (`tokenURI` → `radbro.xyz/api/.../metadata/{id}` → IPFS).
Radbro artwork and branding are CC0, derive from the CC0 Milady ecosystem, and are
used here with authorization from Radbro Webring Corporation, which develops
RADWALLET and holds the Radbro IP rights. Screenshots of third-party interfaces
remain documentary design references rather than a claim over those interfaces.

---

## 6. Design directions for the Radbro Privacy Wallet

What the research says our MetaMask competitor should feel like:

### Positioning
- **"Founderless, unruggable" energy applied to wallet software**: open source
  (the repo IS the product), no telemetry, no data collection, no swap fees. In the
  age of AI, a gatekept closed-source wallet extension is ridiculous — lean into
  that as the founding meme.
- Radbro's whole art direction is *anti-CONSUME/OBEY* — a wallet that doesn't spy on
  you or skim 0.875% on swaps (MetaMask's fee) is the product-shaped version of
  that message. Tagline candidates: *"The best and only wallet on the World Wide
  Web."* / *"Your keys were the redacted word."* / *"Just check the chain."* /
  *"We can't see you. That's the point."*

### Visual language (from the sites)
- **Palette**: black base, #FFE800-ish yellow for text/CTAs, starfield accents;
  red/white links; purple + red as rare accent colors (SchizoPosters). Light theme
  optional and ironic.
- **Type**: monospace/pixel for data (addresses, balances, gas), default-system
  serif/sans for the GeoCities flavor headings. Yellow highlighter-block section
  headers like bitcoin.radbro.xyz.
- **Chrome**: plain yellow rectangular buttons ("Connect Wallet" style), rainbow
  `<hr>` dividers, 88×31 badge iconography, tiled starfield backgrounds, sparkle
  crosses.
- **Delight details**: spinning-coin GIF for token icons ($RAD-style), a hit-counter
  LCD widget showing current block number, "under construction" GIF for pending
  transactions, an "Award of Elegance" easter egg after the user's first
  self-custody backup, `[TRANSACTION INTENSIFIES]` toast while a tx is in the
  mempool.
- **Webring as UX metaphor**: `← Prev | Next →` to cycle between accounts/networks;
  a literal webring footer linking other open-source privacy tools.

### Product mechanics worth mirroring
- **Radswap's cart + slippage UI** proves the audience tolerates real DeFi controls
  inside a meme skin — our built-in 0-fee swap can expose honest slippage/route
  detail instead of hiding it.
- **"Check a Bro's unclaimed $RAD" by token ID** — public, no-wallet-needed lookups
  are part of the culture; our wallet should have a watch-only/"check any address"
  mode front and center.
- **Cross-chain seriousness** (RBRC-721, oracle-synced dual mints) — the community
  respects protocol competence delivered with shitpost framing; privacy features
  (no RPC data leakage, rotating addresses, local tx simulation) should be
  documented Substack-style: rigorous content, "Love, Radbro Webring" tone.

### Privacy guarantees to engineer (the substance behind the skin)
- No analytics/telemetry of any kind; no account system.
- Default RPC strategy that doesn't leak the user's full address set to one
  provider (per-account endpoints, optional user RPC, light-client roadmap).
- Built-in swap with **zero wallet fee**, routed transparently.
- Local transaction simulation & human-readable signing (anti-OBEY).
- Fully open source under a permissive/viral license, reproducible builds.

---

## 7. Sources

- [radbro.xyz](https://radbro.xyz/) (+ /bros, /cats, /rad, /club)
- [bitcoin.radbro.xyz — Radbro Satoshis Vision](https://bitcoin.radbro.xyz/)
- [schizoposters.xyz](https://schizoposters.xyz/)
- [radder.xyz](https://radder.xyz/)
- [Radbro — Remilia Wiki](https://wiki.remilia.org/Radbro)
- [radbro webring official Substack](https://radbro.substack.com/) — incl.
  [RBRC-721 metaprotocol](https://radbro.substack.com/p/rbrc-721-radbro-ordinals-nft-metaprotocol),
  [Lasogette bridging guide](https://radbro.substack.com/p/lasogettes-rbrc-721-bridging-guide),
  [BTC, Halving & Runes statement](https://radbro.substack.com/p/radbro-webring-btc-halving-and-runes)
- [RADBRO WEBRING (OFFICIAL) on X](https://x.com/radbro_webring) — incl. the
  [RBRC-721 mint dynamics thread](https://x.com/radbro_webring/status/1760819481817813097)
- [OpenSea: Radbro Webring V2](https://opensea.io/collection/radbro-webring) ·
  [Radcats](https://opensea.io/collection/radbro-radcats) ·
  [SchizoPosters](https://opensea.io/collection/schizoposters)
- [Etherscan: RADBROS token tracker](https://etherscan.io/token/0xabcdb5710b88f456fed1e99025379e2969f29610) ·
  [Radcoin (RAD)](https://etherscan.io/token/0x6af36add4e2f6e8a9cb121450d59f6c30f3f3722)
- [CoinGecko: Radbro Webring V2 floor chart](https://www.coingecko.com/en/nft/radbro-webring) ·
  [Forbes digital assets page](https://www.forbes.com/digital-assets/nfts/radbro-webring-v2-radbros/) ·
  [CoinMarketCap](https://coinmarketcap.com/nft/collections/eth/0xabcdb5710b88f456fed1e99025379e2969f29610/Radbro%20Webring%20V2/) ·
  [DappRadar](https://dappradar.com/nft-collection/radbro-webring-1)
- [Delphi Digital on SchizoPosters (X)](https://x.com/Delphi_Digital/status/1792608896089022648) ·
  [Delphi: Milady — NFTs as Onchain Cults](https://members.delphidigital.io/reports/milady-nfts-as-onchain-cults)
- On-chain: `tokenURI` calls against V2 (`0xabcd…9610`) and Radcats
  (`0x3bFC…964F`) via public RPC; metadata from `radbro.xyz/api/*/metadata/{id}`.
