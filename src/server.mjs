/**
 * Keryx HTTP server — plain Node, no framework.
 *
 * Routes:
 *   POST /register          — register an article
 *   GET  /articles          — list all articles
 *   POST /match             — find best matching article for cited text
 *   POST /cite/:articleId   — x402-protected citation toll
 *   POST /demo/cite         — server-side agent simulation (no browser wallet)
 *   GET  /audit             — circuit-breaker audit log
 *   GET  /health            — liveness check
 *   GET  /                  — static dashboard
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

import { register, get, list, findBestMatch } from "./registry.mjs";
import { check, getAudit } from "./breaker.mjs";
import {
  buildPaymentRequirements,
  verify,
  settle,
  DRY_RUN,
} from "./x402.mjs";

const PORT      = parseInt(process.env.PORT ?? "3000", 10);
// TEST_MODE enables the X-Test-Payer header for simulated payer addresses.
// NEVER enable this on a publicly reachable deployment — any client could
// rotate payers to bypass PAYER_RATE_CAP and REPLAY_TOO_SOON.
const TEST_MODE = process.env.TEST_MODE === "1";

// Read static dashboard once at startup
const DASHBOARD_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));
let dashboardHtml;
try {
  dashboardHtml = readFileSync(DASHBOARD_PATH, "utf-8");
} catch {
  dashboardHtml = "<h1>Dashboard not found — build public/index.html</h1>";
}

// ─── helpers ────────────────────────────────────────────────────────────────

function body(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function routeMatch(pathname, pattern) {
  // Returns params or null
  const patParts = pattern.split("/");
  const urlParts = pathname.split("/");
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(":")) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

// ─── route handlers ──────────────────────────────────────────────────────────

async function handleRegister(req, res) {
  const b = await body(req);
  try {
    const id = register(b);
    send(res, 201, { id, message: "Article registered" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}

async function handleArticles(_req, res) {
  const articles = list().map(({ id, url, title, priceUsdc, payTo, registeredAt }) => ({
    id, url, title, priceUsdc, payTo, registeredAt,
  }));
  send(res, 200, articles);
}

async function handleMatch(req, res) {
  const b = await body(req);
  const { citedText } = b;
  if (!citedText) return send(res, 400, { error: "citedText required" });
  const result = findBestMatch(citedText);
  if (!result) return send(res, 404, { error: "No articles registered" });
  send(res, 200, {
    articleId: result.article.id,
    title: result.article.title,
    score: result.score,
    priceUsdc: result.article.priceUsdc,
  });
}

async function handleCite(req, res, { articleId }) {
  const article = get(articleId);
  if (!article) return send(res, 404, { error: "Article not found" });

  const requirements = buildPaymentRequirements(article.payTo, article.priceUsdc);

  // ── x402: check for payment header ───────────────────────────────────────
  const paymentHeader = req.headers["payment-signature"] || req.headers["x-payment"];

  if (!paymentHeader) {
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: `/cite/${articleId}`,
        description: `Citation toll — ${article.title} (${article.priceUsdc} USDC)`,
        mimeType: "application/json",
      },
      accepts: [requirements],
    };
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
      "Access-Control-Allow-Origin": "*",
    });
    return res.end(JSON.stringify({ error: "Payment Required" }));
  }

  // ── Parse payment payload ─────────────────────────────────────────────────
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  } catch {
    return send(res, 400, { error: "Invalid payment-signature header" });
  }

  // ── Breaker check (BEFORE settle — no money moves on a rejection) ────────
  // Real payer comes from the signed authorization. X-Test-Payer is only honoured
  // when TEST_MODE=1 — never enable that on a publicly reachable deployment, since
  // reverse proxies make all external requests appear to come from 127.0.0.1 and a
  // socket-address check cannot distinguish them from genuine localhost traffic.
  const testPayerHeader = TEST_MODE ? req.headers["x-test-payer"] : undefined;
  const payer = (
    testPayerHeader ??
    paymentPayload?.payload?.authorization?.from ??
    paymentPayload?.payer ??
    "unknown"
  ).toLowerCase();

  const b = await body(req).catch(() => ({}));
  const citedText = b.citedText ?? "";
  const { containment: similarity } = await import("./fingerprint.mjs")
    .then((m) => ({ containment: m.containment(citedText, article.text) }));
  const breakResult = check({
    payer,
    articleId,
    amountUsdc: article.priceUsdc,
    similarity,
  });

  if (!breakResult.allowed) {
    // Embed rule name in error string so GatewayClient.pay() can propagate it.
    return send(res, 402, {
      error: `Circuit breaker: ${breakResult.rule}`,
      rule: breakResult.rule,
      reason: breakResult.reason,
    });
  }

  // ── Settle ────────────────────────────────────────────────────────────────
  const settleResult = await settle(paymentPayload, requirements);
  if (!settleResult.success) {
    console.error(`[handleCite] settle failed: ${JSON.stringify(settleResult)}`);
    return send(res, 500, { error: "Settlement failed", reason: settleResult.errorReason });
  }

  send(res, 200, {
    success: true,
    articleId,
    title: article.title,
    amountUsdc: article.priceUsdc,
    payer,
    transaction: settleResult.transaction,
    similarity,
    dryRun: DRY_RUN,
  });
}

async function handleDemoCite(req, res) {
  // Server-side agent simulation — no browser wallet needed.
  // DRY_RUN: fake payload through the same verify/breaker/settle stubs.
  // Real mode: GatewayClient holds BUYER_PRIVATE_KEY and drives the full
  //   x402 sign-and-retry handshake against /cite/:articleId on localhost,
  //   exactly as agent.mts does. The fake payload construction is NOT used
  //   in real mode — BatchFacilitatorClient.verify() requires resource,
  //   accepted, payload.signature, and payload.authorization, which only a
  //   real GatewayClient can produce.
  const b = await body(req);
  const { articleId, citedText, payer = "0xDEAD000000000000000000000000000000000001", simulatedPayer } = b;

  if (!articleId || !citedText) {
    return send(res, 400, { error: "articleId and citedText required" });
  }

  if (DRY_RUN) {
    // ── DRY_RUN path: fake payload through stubs ───────────────────────────
    const article = get(articleId);
    if (!article) return send(res, 404, { error: "Article not found" });

    const { containment } = await import("./fingerprint.mjs");
    const similarity = containment(citedText, article.text);
    const requirements = buildPaymentRequirements(article.payTo, article.priceUsdc);
    const fakePayload = { payer, payload: { from: payer }, x402Version: 2 };

    const verifyResult = await verify(fakePayload, requirements);
    if (!verifyResult.isValid) {
      return send(res, 402, { error: "Verify failed", reason: verifyResult.invalidReason });
    }

    const breakResult = check({ payer, articleId, amountUsdc: article.priceUsdc, similarity });
    if (!breakResult.allowed) {
      return send(res, 402, { error: "Circuit breaker blocked", rule: breakResult.rule, reason: breakResult.reason });
    }

    const settleResult = await settle(fakePayload, requirements);
    if (!settleResult.success) {
      return send(res, 500, { error: "Settlement failed", reason: settleResult.errorReason });
    }

    return send(res, 200, {
      success: true, articleId, title: article.title,
      amountUsdc: article.priceUsdc, payer,
      transaction: settleResult.transaction, similarity, dryRun: true,
    });
  }

  // ── Real mode: GatewayClient drives the full x402 handshake ───────────────
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey) {
    return send(res, 500, { error: "BUYER_PRIVATE_KEY not set — run: npm run generate-wallets" });
  }

  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });

  // Deposit the article price into the Gateway if balance is insufficient.
  // GatewayClient.pay() draws from gateway balance, not the ERC-20 wallet directly.
  const article = get(articleId);
  if (!article) return send(res, 404, { error: "Article not found" });

  const balances = await gateway.getBalances();
  console.log(`[demo/cite] wallet USDC=${balances.wallet.formatted} gateway available=${balances.gateway.formattedAvailable}`);
  const neededAtomic = BigInt(Math.round(parseFloat(article.priceUsdc) * 1_000_000));
  if (balances.gateway.available < neededAtomic) {
    console.log(`[demo/cite] Gateway balance low, depositing ${article.priceUsdc} USDC...`);
    const depositResult = await gateway.deposit(article.priceUsdc);
    console.log(`[demo/cite] Deposit tx: ${depositResult.depositTxHash}`);
  }

  // gateway.pay() handles the complete x402 flow:
  //   1. POST /cite/:articleId → server returns 402 + PAYMENT-REQUIRED header
  //   2. GatewayClient reads requirements, signs a proper payload with privateKey
  //   3. Retries POST with payment-signature header containing the signed payload
  //   4. /cite/:articleId calls facilitator.verify() then breaker then facilitator.settle()
  //   5. Returns the 200 response body from /cite/:articleId
  const citeUrl = `http://localhost:${PORT}/cite/${articleId}`;
  // simulatedPayer lets the exercise script assign distinct identities per call
  // without separate wallets. Forwarded as X-Test-Payer and only honoured for
  // localhost requests (enforced in handleCite).
  const extraHeaders = simulatedPayer ? { "X-Test-Payer": simulatedPayer } : {};

  let result;
  try {
    result = await gateway.pay(citeUrl, { method: "POST", body: { citedText }, headers: extraHeaders });
  } catch (e) {
    const msg = e.message ?? "";
    // "Payment failed: Circuit breaker: RULE_NAME" — rule name is parseable
    const ruleMatch = msg.match(/Circuit breaker: (\w+)/);
    if (ruleMatch) {
      return send(res, 402, {
        error: "Circuit breaker blocked payment",
        rule: ruleMatch[1],
        reason: msg,
      });
    }
    // Settle failed (insufficient_balance, etc.) — distinct from an unexpected crash
    if (msg.includes("Settlement failed") || msg.includes("insufficient_balance")) {
      return send(res, 502, { error: "Settlement failed", message: msg });
    }
    throw e; // re-throw; outer catch returns 500 with full message
  }

  // result.data is handleCite's 200 body: { success, transaction, similarity, ... }
  // result.amount is a BigInt from GatewayClient — serialize explicitly.
  send(res, 200, {
    ...result.data,
    formattedAmount: result.formattedAmount,
    transaction: result.transaction || result.data?.transaction,
    dryRun: false,
  });
}

async function handleAudit(_req, res) {
  const log = getAudit();
  const settled = log.filter((e) => e.allowed);
  const totalPaidOut = settled.reduce((s, e) => s + parseFloat(e.amountUsdc), 0);
  send(res, 200, {
    totalCitations: settled.length,
    totalPaidOutUsdc: totalPaidOut.toFixed(6),
    log,
  });
}

// ─── server ─────────────────────────────────────────────────────────────────

// Process-level safety net: an unhandled rejection must never kill the server.
// With `return await` in the dispatcher below this is a last-resort backstop only.
process.on("uncaughtException", (err) => {
  console.error("[keryx] uncaughtException (server kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[keryx] unhandledRejection (server kept alive):", reason);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const { pathname } = url;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
    return res.end();
  }

  // `return await` is required here — inside an async function, `return promise`
  // does NOT place rejections inside the enclosing try/catch; only `return await`
  // does, because that suspends execution until the promise settles.
  try {
    if (method === "GET" && pathname === "/") return sendHtml(res, dashboardHtml);
    if (method === "GET" && pathname === "/health") return send(res, 200, { ok: true, dryRun: DRY_RUN });
    if (method === "POST" && pathname === "/register") return await handleRegister(req, res);
    if (method === "GET" && pathname === "/articles") return await handleArticles(req, res);
    if (method === "POST" && pathname === "/match") return await handleMatch(req, res);
    if (method === "POST" && pathname === "/demo/cite") return await handleDemoCite(req, res);
    if (method === "GET" && pathname === "/audit") return await handleAudit(req, res);

    const citeParams = routeMatch(pathname, "/cite/:articleId");
    if (method === "POST" && citeParams) return await handleCite(req, res, citeParams);

    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[server] request error:", e);
    if (!res.headersSent) send(res, 500, { error: "Internal server error", message: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[keryx] ${DRY_RUN ? "DRY_RUN " : ""}server running at http://localhost:${PORT}`);
});
