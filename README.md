# Keryx

**Pay-per-citation toll for AI agents**  
Lepton Agents Hackathon — Canteen × Circle × Arc

Keryx sits between an AI agent and a content registry. When an agent cites a piece of registered content it must pay a micro-toll ($0.001–$1.00 USDC) via the [x402 protocol](https://x402.org) before the server returns the citation receipt. Payments settle on-chain on Arc Testnet through Circle's GatewayWallet batching system. A five-rule circuit breaker prevents fabricated citations, replay attacks, rate abuse, and coordinated volume spikes.

### Verified on-chain settlement

Real settlement has been independently verified end-to-end, not just asserted:

- A $0.002 USDC citation payment was submitted via `BatchFacilitatorClient.settle()` and returned Circle tracking UUID `e9ccf6cb-e30c-4f63-ae0d-1060e9135896`.
- `poll-transfer.mjs` polled `GatewayClient.getTransferById()` until status reached `completed`.
- `find-batch-tx.mjs` scanned Arc Testnet blocks near the settlement timestamp and identified the on-chain batch transaction.
- `inspect-batch-tx.mjs` and `verify-payment-log.mjs` confirmed the batch calldata contains the exact buyer address (`0x98b4d5681c469dc1a197075c755d9021d2492ff2`), seller address, and amount (2000 atomic units = $0.002 USDC).
- The confirmed batch transaction hash is **`0x360dd89321d236cbcd2779801fb2d3ab41f2a6576f08b45cc01158f88e960a95`** (block 49247070), independently verifiable at [testnet.arcscan.app](https://testnet.arcscan.app).
- Gateway balance drop was independently confirmed via `npm run check-balances` before and after settlement.

---

## How it works

```
AI Agent
  │
  ├─ POST /demo/cite  ──→  GatewayClient.pay()
  │                            │
  │                            ├─ 1. POST /cite/:id  → server returns 402 + PAYMENT-REQUIRED header
  │                            ├─ 2. GatewayClient signs EIP-3009 authorization with buyer private key
  │                            └─ 3. Retry POST with Payment-Signature header
  │
  └─ /cite/:id handler
       ├─ Circuit breaker check  (similarity, replay, rate cap, volume)
       ├─ BatchFacilitatorClient.settle()  → Circle Gateway API → Arc Testnet batch tx
       └─ 200 { success, transaction, similarity, amountUsdc }
```

Payments are batched by Circle's Gateway into periodic on-chain transactions. The UUID returned from `settle()` is a Circle tracking ID, not a tx hash. Individual payments appear in batch calldata, not as ERC-20 Transfer events.

---

## Circuit breaker rules

| # | Rule | Condition | Action |
|---|------|-----------|--------|
| 1 | `LOW_SIMILARITY` | W-shingling containment score < 0.30 | Block, no charge |
| 2 | `AMOUNT_TOO_LARGE` | Article price > $1.00 | Block, no charge |
| 3 | `REPLAY_TOO_SOON` | Same payer + article within 5 seconds | Block, no charge |
| 4 | `PAYER_RATE_CAP` | Payer would exceed $0.05 in any 60-second window | Block, no charge |
| 5 | `ARTICLE_VOLUME_ANOMALY` | Article cited > 20 times in 60 seconds | Block + auto-pause article |

All decisions (allowed and blocked) are appended to an in-memory audit log visible at `GET /audit`.

---

## Setup

### Requirements

- Node.js >= 20.18.2
- A funded Arc Testnet USDC wallet (buyer)
- A seller wallet address to receive citations

### 1. Install

```bash
npm install
```

### 2. Generate wallets

```bash
npm run generate-wallets
```

Creates `.env.local` with `BUYER_PRIVATE_KEY` and `SELLER_ADDRESS`. Fund the buyer wallet with Arc Testnet USDC from the [Circle faucet](https://faucet.circle.com/) before continuing.

### 3. Seed articles

```bash
npm run seed
```

Registers a set of fixture articles into the in-memory registry.

---

## Running the server

| Command | What it does |
|---------|-------------|
| `npm start` | Production mode — real x402 settlements on Arc Testnet |
| `npm run start:dry` | DRY_RUN mode — fake settlements, no on-chain transactions |
| `npm run start:test` | TEST_MODE — real settlements + `X-Test-Payer` header enabled (local testing only, **never expose publicly**) |

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BUYER_PRIVATE_KEY` | Yes (real mode) | Hex private key for the buyer wallet |
| `SELLER_ADDRESS` | Yes | Wallet address that receives citation payments |
| `DRY_RUN` | No | Set to `1` to skip on-chain settlements |
| `TEST_MODE` | No | Set to `1` to honour `X-Test-Payer` header for payer simulation. **Never enable on a public deployment** — reverse proxies make all external requests appear local, so any visitor could forge payer identities and bypass `PAYER_RATE_CAP` and `REPLAY_TOO_SOON`. |
| `PORT` | No | HTTP port (default: 3000) |

---

## API

### `POST /register`

Register an article.

```json
{
  "url": "https://example.com/article",
  "title": "Article title",
  "text": "Full article body (used for citation similarity matching)",
  "priceUsdc": "0.002",
  "payTo": "0xSELLER_ADDRESS"
}
```

Returns `{ "id": "<hex-id>" }`.

### `GET /articles`

List all registered articles (id, url, title, priceUsdc, payTo).

### `POST /match`

Find the best-matching article for a cited snippet.

```json
{ "citedText": "quoted passage here" }
```

Returns `{ articleId, title, score, priceUsdc }`.

### `POST /cite/:articleId`

x402-protected citation endpoint. Clients without a valid `Payment-Signature` header receive a `402 Payment Required` response with a `PAYMENT-REQUIRED` header (base64 JSON) describing the payment terms. Use `GatewayClient.pay()` to drive the handshake automatically.

### `POST /demo/cite`

Server-side agent simulation — no browser wallet required. The server holds `BUYER_PRIVATE_KEY` and drives the full x402 handshake internally.

```json
{
  "articleId": "<id>",
  "citedText": "the quoted passage",
  "simulatedPayer": "0xADDRESS"
}
```

`simulatedPayer` is forwarded as `X-Test-Payer` to the inner `/cite` request. Only honoured when `TEST_MODE=1` on the server.

### `GET /audit`

Returns the full circuit-breaker decision log.

```json
{
  "totalCitations": 38,
  "totalPaidOutUsdc": "0.071000",
  "log": [
    { "rule": "SETTLED", "allowed": true, "payer": "0x...", "articleId": "...", "similarity": 1, "amountUsdc": "0.002", "timestamp": "..." },
    { "rule": "LOW_SIMILARITY", "allowed": false, ... }
  ]
}
```

### `GET /health`

```json
{ "ok": true, "dryRun": false }
```

### `GET /`

Static dashboard (HTML).

---

## Exercising the circuit breaker

To verify all five rules fire correctly, start the server in test mode and run the exercise script:

```bash
# Terminal 1
npm run start:test

# Terminal 2 — in a new shell with .env.local loaded
npm run seed
npm run exercise
```

The exercise script:

1. Pre-funds the Gateway wallet with $0.15 USDC (enough for the full run without mid-test deposits that would push calls outside the 60-second rate window).
2. Fires one call per rule in order, using distinct `simulatedPayer` addresses so rules don't collide with each other.
3. Prints a summary and confirms all five rules appear in the audit log.

Expected output:

```
✓ All 5 rules exercised successfully.
By rule:
  SETTLED: 38
  LOW_SIMILARITY: 1
  REPLAY_TOO_SOON: 1
  PAYER_RATE_CAP: 1
  ARTICLE_VOLUME_ANOMALY: 1
```

---

## Architecture

```
src/
  server.mjs       — HTTP server (no framework), all route handlers
  x402.mjs         — Payment requirements builder + BatchFacilitatorClient wrapper
  breaker.mjs      — Five-rule circuit breaker with in-memory audit log
  fingerprint.mjs  — W-shingling similarity / containment scoring
  registry.mjs     — In-memory article registry
  demo-agent.mjs   — Standalone agent demo (DRY_RUN)

scripts/
  seed-fixtures.mjs      — Register fixture articles
  seed-exercise.mjs      — Exercise all 5 breaker rules end-to-end
  ingest-rss.mjs         — Pull articles from RSS feeds into the registry
  generate-wallets.mjs   — Generate buyer/seller keypairs and write .env.local
  check-balances.mjs     — Print current wallet and gateway balances
  poll-transfer.mjs      — Poll GatewayClient.getTransferById() until a settlement UUID reaches completed status
  find-batch-tx.mjs      — Scan Arc Testnet blocks near a timestamp to locate the on-chain batch transaction
  inspect-batch-tx.mjs   — Fetch logs and first 32 bytes of calldata for candidate batch transactions
  verify-payment-log.mjs — Confirm buyer address, seller address, and amount appear in batch calldata

public/
  index.html         — Dashboard UI
```

---

## Network details

| Parameter | Value |
|-----------|-------|
| Chain | Arc Testnet (chain ID 5042002) |
| USDC contract | `0x3600000000000000000000000000000000000000` |
| GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Block explorer | https://testnet.arcscan.app |
| Circle Gateway API | https://gateway-api-testnet.circle.com |

`maxTimeoutSeconds` is set to `604900` (7 days + 100 s buffer) to satisfy Circle's Gateway minimum authorization validity window.

---

## License

MIT
