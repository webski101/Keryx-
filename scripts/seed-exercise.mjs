/**
 * Exercises all 5 circuit-breaker rules via real function calls.
 * Every log entry is produced by an actual check() call — nothing is fabricated.
 *
 * In DRY_RUN mode payer addresses from the request body are used directly.
 * In real mode, gateway.pay() always signs with the funded wallet, so the
 * breaker would see the same payer address for every call. We pass a
 * `simulatedPayer` field that handleDemoCite forwards as X-Test-Payer to the
 * inner /cite request, which handleCite uses for breaker tracking instead of
 * the wallet address (localhost-only, enforced server-side).
 *
 * We also pre-fund the gateway with enough USDC for the whole run so no
 * per-call deposits are needed — those take ~30 s each and push calls outside
 * the 60-second PAYER_RATE_CAP window.
 *
 * Requires the server to be running (DRY_RUN=1 or real mode).
 * Usage: node scripts/seed-exercise.mjs
 */

const BASE    = process.env.BASE_URL ?? "http://localhost:3000";
const DRY_RUN = process.env.DRY_RUN === "1";

// ── Pre-fund the gateway (real mode only) ─────────────────────────────────────
// Without this, each settle call depletes the balance and subsequent calls need
// deposits that take ~30 s (waitForTransactionReceipt), pushing them outside the
// 60-second PAYER_RATE_CAP window.
if (!DRY_RUN) {
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("BUYER_PRIVATE_KEY not set — run: npm run generate-wallets");
    process.exit(1);
  }
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const gw = new GatewayClient({ chain: "arcTestnet", privateKey });

  // Budget: Rule1 $0.002 + Rule3 $0.002 + Rule4 18×$0.003=$0.054 + Rule5 21×$0.002=$0.042 = $0.100
  const PREFUND_ATOMIC = 150_000n; // $0.15 with buffer
  const bal = await gw.getBalances();
  const available = bal.gateway.available;
  if (available < PREFUND_ATOMIC) {
    const need = PREFUND_ATOMIC - available;
    // Convert atomic units (6-decimal) to USDC string
    const usdcStr = (Number(need) / 1_000_000).toFixed(6);
    console.log(`[prefund] Gateway balance ${bal.gateway.formattedAvailable} USDC — depositing ${usdcStr} USDC for the run…`);
    const dep = await gw.deposit(usdcStr);
    console.log(`[prefund] Deposit tx: ${dep.depositTxHash}`);
    // Brief pause for Circle's API to index the deposit
    await new Promise(r => setTimeout(r, 3000));
  } else {
    console.log(`[prefund] Gateway balance ${bal.gateway.formattedAvailable} USDC — sufficient, no deposit needed`);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function post(path, data) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return r.json();
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return r.json();
}

/**
 * Fire a citation request.
 * simulatedPayer: used for breaker tracking in real mode (X-Test-Payer header).
 * In DRY_RUN, the server reads `payer` from the body directly.
 */
async function cite(articleId, citedText, payerAddr) {
  return post("/demo/cite", {
    articleId,
    citedText,
    payer: payerAddr,           // used in DRY_RUN
    simulatedPayer: payerAddr,  // used in real mode via X-Test-Payer
  });
}

function rule(label) {
  console.log(`\n── ${label} ──`);
}

// ── 1. Get articles from the running server ───────────────────────────────────
const articlesIndex = await get("/articles");
if (articlesIndex.length === 0) {
  console.error("No articles found. Run: npm run seed");
  process.exit(1);
}
// /articles omits 'text'; /articles/:id returns the full record
const articles = await Promise.all(
  articlesIndex.map(a =>
    fetch(`${BASE}/articles/${a.id}`).then(r => r.json())
  )
);
const a = articles[0];
console.log(`Using article: [${a.id}] ${a.title.slice(0, 50)}`);

// ── RULE 1: SETTLED — genuine quote ──────────────────────────────────────────
rule("RULE 1 → SETTLED (genuine citation)");
const genuineSnippet = `The Arc blockchain network has processed over 50 million micropayments in its first quarter of operation, enabling content creators to receive fractions of a cent`;
const arcArticle = articles.find((x) => x.title.includes("Arc Blockchain")) ?? a;
const r1 = await cite(arcArticle.id, genuineSnippet, "0xPAYER_GOOD_0000000000000000000000001");
console.log("Result:", r1);

// ── RULE 2: LOW_SIMILARITY — fabricated citation ──────────────────────────────
rule("RULE 2 → LOW_SIMILARITY (fabricated text)");
const r2 = await cite(a.id,
  "The ancient Romans invented the first cryptocurrency using olive oil as collateral backing.",
  "0xPAYER_FABR_0000000000000000000000002");
console.log("Result:", r2);

// ── RULE 3: REPLAY_TOO_SOON — same payer+article twice ───────────────────────
rule("RULE 3 → REPLAY_TOO_SOON (instant repeat)");
const replaySnippet = `A landmark study published in the New England Journal of Medicine found that OpenAI's latest language model outperformed board-certified physicians in diagnosing rare diseases`;
const medArticle = articles.find((x) => x.title.includes("GPT-5")) ?? a;
await cite(medArticle.id, replaySnippet, "0xPAYER_RPLY_0000000000000000000000003");
const r3 = await cite(medArticle.id, replaySnippet, "0xPAYER_RPLY_0000000000000000000000003");
console.log("Result (second attempt):", r3);

// ── RULE 4: PAYER_RATE_CAP — blow $0.05/60s window ──────────────────────────
rule("RULE 4 → PAYER_RATE_CAP (rate limit exceeded)");
const capPayer = "0xPAYER_CAP_00000000000000000000000004";
// Register 18 throwaway articles at $0.003 each. 18 × $0.003 = $0.054 → trips the $0.05/60s cap.
// Distinct articles prevent REPLAY_TOO_SOON from firing before PAYER_RATE_CAP.
const capIds = [];
for (let i = 0; i < 18; i++) {
  const r = await post("/register", {
    url: `https://exercise.test/cap-article-${i}`,
    title: `Rate Cap Test Article ${i}`,
    text: `Quantum cryptography post quantum encryption standards NIST CRYSTALS-Kyber CRYSTALS-Dilithium RSA elliptic curve article number ${i} for rate cap exercise testing purposes only`,
    priceUsdc: "0.003",
    payTo: process.env.SELLER_ADDRESS ?? "0xSELLER0000000000000000000000000000000001",
  });
  capIds.push(r.id);
}
let capTotal = 0;
for (let i = 0; i < capIds.length; i++) {
  const snippet = `Quantum cryptography post quantum encryption standards NIST article number ${i} for rate cap exercise testing purposes`;
  const result = await cite(capIds[i], snippet, capPayer);
  const msg = result.success
    ? `settled $${result.amountUsdc} (total: $${(capTotal + parseFloat(result.amountUsdc ?? 0)).toFixed(3)})`
    : result.rule ?? result.error;
  console.log(`  cite ${i + 1}:`, msg);
  if (result.success) capTotal += parseFloat(result.amountUsdc ?? 0);
  if (!result.success && result.rule === "PAYER_RATE_CAP") break;
}

// ── RULE 5: ARTICLE_VOLUME_ANOMALY — 21 citations to one article ─────────────
rule("RULE 5 → ARTICLE_VOLUME_ANOMALY (burst attack)");
// Use the most-recently registered article as the burst target so it starts
// with a clean volume counter. In real mode, simulatedPayer gives the breaker
// a distinct payer per call, preventing REPLAY_TOO_SOON from firing before
// ARTICLE_VOLUME_ANOMALY accumulates 20 citations.
const targetArticle = articles.find((x) => x.title.includes("RSS")) ?? articles[articles.length - 1];
console.log(`Bursting article: ${targetArticle.title.slice(0, 45)}`);
let anomalyTriggered = false;
for (let i = 0; i < 25; i++) {
  const burstPayer = `0x${String(i).padStart(40, "B")}`;
  const snippet = targetArticle.text.slice(i * 2, 90 + i * 2);
  const result = await cite(targetArticle.id, snippet, burstPayer);
  if (result.rule === "ARTICLE_VOLUME_ANOMALY" || result.rule === "ARTICLE_PAUSED") {
    console.log(`  ✓ Anomaly triggered at citation ${i + 1}:`, result.rule);
    anomalyTriggered = true;
    break;
  }
  // In real mode, settle may fail after the breaker passes — log but continue.
  if (!result.success) {
    const why = result.rule ?? result.error ?? "unknown";
    if (result.rule) {
      console.log(`  [${i + 1}] unexpected breaker rule: ${why}`);
    }
    // settlement failure (502) is expected when gateway balance is briefly stale
  }
}
if (!anomalyTriggered) {
  console.log("  (anomaly rule may have triggered on an earlier rule — check /audit)");
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n══ AUDIT SUMMARY ══");
const audit = await get("/audit");
const byRule = {};
for (const e of audit.log) {
  const r = e.rule ?? "UNKNOWN";
  byRule[r] = (byRule[r] ?? 0) + 1;
}
console.log(`Total entries: ${audit.log.length}`);
console.log(`Total paid out: $${audit.totalPaidOutUsdc} USDC`);
console.log("By rule:");
for (const [r, count] of Object.entries(byRule)) {
  console.log(`  ${r}: ${count}`);
}

const requiredRules = ["SETTLED", "LOW_SIMILARITY", "REPLAY_TOO_SOON", "PAYER_RATE_CAP", "ARTICLE_VOLUME_ANOMALY"];
const missing = requiredRules.filter((r) => !byRule[r]);
if (missing.length === 0) {
  console.log("\n✓ All 5 rules exercised successfully.");
} else {
  console.log(`\n⚠ Missing rules in audit: ${missing.join(", ")}`);
}
