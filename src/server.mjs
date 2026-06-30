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
 *
 * On Vercel (process.env.VERCEL set): exports `handler` as default for the
 * serverless runtime — no server.listen() call. Otherwise starts a local
 * HTTP server on PORT.
 */

import { createServer }      from "node:http";
import { readFileSync }       from "node:fs";
import { URL, fileURLToPath } from "node:url";

import { register, get, list, findBestMatch } from "./registry.mjs";
import { check, getAudit }                    from "./breaker.mjs";
import {
  buildPaymentRequirements,
  verify,
  settle,
  DRY_RUN,
} from "./x402.mjs";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
// TEST_MODE enables the X-Test-Payer header for simulated payer addresses.
// NEVER enable this on a publicly reachable deployment — reverse proxies make
// all external requests appear local, so any visitor could forge payer
// identities and bypass PAYER_RATE_CAP and REPLAY_TOO_SOON.
const TEST_MODE = process.env.TEST_MODE === "1";

// Read static dashboard once at startup (read-only — works on Vercel)
const DASHBOARD_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));
let dashboardHtml;
try {
  dashboardHtml = readFileSync(DASHBOARD_PATH, "utf-8");
} catch {
  dashboardHtml = "<h1>Dashboard not found — build public/index.html</h1>";
}

// ─── helpers ────────────────────────────────────────────────────────────────

function body(req) {
  // Vercel's runtime may pre-parse the body — use it if already present
  if (req.body !== undefined) {
    return Promise.resolve(
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {})
    );
  }
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
    const id = await register(b);
    send(res, 201, { id, message: "Article registered" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}

async function handleArticles(_req, res) {
  const articles = (await list()).map(({ id, url, title, priceUsdc, payTo, registeredAt }) => ({
    id, url, title, priceUsdc, payTo, registeredAt,
  }));
  send(res, 200, articles);
}

async function handleArticleById(req, res, { articleId }) {
  const article = await get(articleId);
  if (!article) return send(res, 404, { error: "Article not found" });
  const { id, url, title, text, priceUsdc, payTo, registeredAt } = article;
  send(res, 200, { id, url, title, text, priceUsdc, payTo, registeredAt });
}

async function handleMatch(req, res) {
  const b = await body(req);
  const { citedText } = b;
  if (!citedText) return send(res, 400, { error: "citedText required" });
  const result = await findBestMatch(citedText);
  if (!result) return send(res, 404, { error: "No articles registered" });
  send(res, 200, {
    articleId: result.article.id,
    title:     result.article.title,
    score:     result.score,
    priceUsdc: result.article.priceUsdc,
  });
}

async function handleCite(req, res, { articleId }) {
  const article = await get(articleId);
  if (!article) return send(res, 404, { error: "Article not found" });

  const requirements = buildPaymentRequirements(article.payTo, article.priceUsdc);

  // ── x402: check for payment header ───────────────────────────────────────
  const paymentHeader = req.headers["payment-signature"] || req.headers["x-payment"];

  if (!paymentHeader) {
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url:         `/cite/${articleId}`,
        description: `Citation toll — ${article.title} (${article.priceUsdc} USDC)`,
        mimeType:    "application/json",
      },
      accepts: [requirements],
    };
    res.writeHead(402, {
      "Content-Type":    "application/json",
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

  // ── Breaker check (BEFORE settle) ────────────────────────────────────────
  // X-Test-Payer is only honoured when TEST_MODE=1 — never enable on a public
  // deployment; reverse proxies make all external requests appear local.
  const testPayerHeader = TEST_MODE ? req.headers["x-test-payer"] : undefined;
  const payer = (
    testPayerHeader ??
    paymentPayload?.payload?.authorization?.from ??
    paymentPayload?.payer ??
    "unknown"
  ).toLowerCase();

  const b = await body(req).catch(() => ({}));
  const citedText = b.citedText ?? "";
  const { containment: sim } = await import("./fingerprint.mjs")
    .then((m) => ({ containment: m.containment(citedText, article.text) }));

  const breakResult = await check({
    payer,
    articleId,
    amountUsdc: article.priceUsdc,
    similarity: sim,
  });

  if (!breakResult.allowed) {
    return send(res, 402, {
      error:  `Circuit breaker: ${breakResult.rule}`,
      rule:   breakResult.rule,
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
    success:     true,
    articleId,
    title:       article.title,
    amountUsdc:  article.priceUsdc,
    payer,
    transaction: settleResult.transaction,
    similarity:  sim,
    dryRun:      DRY_RUN,
  });
}

async function handleDemoCite(req, res) {
  const b = await body(req);
  const {
    articleId,
    citedText,
    payer           = "0xDEAD000000000000000000000000000000000001",
    simulatedPayer,
  } = b;

  if (!articleId || !citedText) {
    return send(res, 400, { error: "articleId and citedText required" });
  }

  if (DRY_RUN) {
    const article = await get(articleId);
    if (!article) return send(res, 404, { error: "Article not found" });

    const { containment } = await import("./fingerprint.mjs");
    const similarity  = containment(citedText, article.text);
    const requirements = buildPaymentRequirements(article.payTo, article.priceUsdc);
    const fakePayload  = { payer, payload: { from: payer }, x402Version: 2 };

    const verifyResult = await verify(fakePayload, requirements);
    if (!verifyResult.isValid) {
      return send(res, 402, { error: "Verify failed", reason: verifyResult.invalidReason });
    }

    const breakResult = await check({ payer, articleId, amountUsdc: article.priceUsdc, similarity });
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

  const article = await get(articleId);
  if (!article) return send(res, 404, { error: "Article not found" });

  const balances     = await gateway.getBalances();
  const neededAtomic = BigInt(Math.round(parseFloat(article.priceUsdc) * 1_000_000));
  if (balances.gateway.available < neededAtomic) {
    console.log(`[demo/cite] Gateway balance low, depositing ${article.priceUsdc} USDC...`);
    const depositResult = await gateway.deposit(article.priceUsdc);
    console.log(`[demo/cite] Deposit tx: ${depositResult.depositTxHash}`);
  }

  const citeUrl     = `http://localhost:${PORT}/cite/${articleId}`;
  const extraHeaders = simulatedPayer ? { "X-Test-Payer": simulatedPayer } : {};

  let result;
  try {
    result = await gateway.pay(citeUrl, { method: "POST", body: { citedText }, headers: extraHeaders });
  } catch (e) {
    const msg = e.message ?? "";
    const ruleMatch = msg.match(/Circuit breaker: (\w+)/);
    if (ruleMatch) {
      return send(res, 402, {
        error:  "Circuit breaker blocked payment",
        rule:   ruleMatch[1],
        reason: msg,
      });
    }
    if (msg.includes("Settlement failed") || msg.includes("insufficient_balance")) {
      return send(res, 502, { error: "Settlement failed", message: msg });
    }
    throw e;
  }

  send(res, 200, {
    ...result.data,
    formattedAmount: result.formattedAmount,
    transaction:     result.transaction || result.data?.transaction,
    dryRun:          false,
  });
}

async function handleAudit(_req, res) {
  const log      = await getAudit();
  const settled  = log.filter((e) => e.allowed);
  const totalOut = settled.reduce((s, e) => s + parseFloat(e.amountUsdc), 0);
  send(res, 200, {
    totalCitations:   settled.length,
    totalPaidOutUsdc: totalOut.toFixed(6),
    log,
  });
}

// ─── request dispatcher ──────────────────────────────────────────────────────

export async function handler(req, res) {
  const url      = new URL(req.url, "http://localhost");
  const { pathname } = url;
  const method   = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    return res.end();
  }

  try {
    if (method === "GET"  && pathname === "/")        return sendHtml(res, dashboardHtml);
    if (method === "GET"  && pathname === "/health")  return send(res, 200, { ok: true, dryRun: DRY_RUN });
    if (method === "POST" && pathname === "/register") return await handleRegister(req, res);
    if (method === "GET"  && pathname === "/articles") return await handleArticles(req, res);
    const articleParams = routeMatch(pathname, "/articles/:articleId");
    if (method === "GET"  && articleParams) return await handleArticleById(req, res, articleParams);
    if (method === "POST" && pathname === "/match")    return await handleMatch(req, res);
    if (method === "POST" && pathname === "/demo/cite") return await handleDemoCite(req, res);
    if (method === "GET"  && pathname === "/audit")   return await handleAudit(req, res);

    const citeParams = routeMatch(pathname, "/cite/:articleId");
    if (method === "POST" && citeParams) return await handleCite(req, res, citeParams);

    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[server] request error:", e);
    if (!res.headersSent) send(res, 500, { error: "Internal server error", message: e.message });
  }
}

// ─── server instance ─────────────────────────────────────────────────────────

process.on("uncaughtException",  (err)    => console.error("[keryx] uncaughtException:",  err));
process.on("unhandledRejection", (reason) => console.error("[keryx] unhandledRejection:", reason));

// createServer is called unconditionally so the instance can be exported as the
// Vercel default export (it expects an http.Server or a handler function).
const server = createServer(handler);

// Only bind a port when running locally — Vercel manages the socket itself.
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`[keryx] ${DRY_RUN ? "DRY_RUN " : ""}${TEST_MODE ? "TEST_MODE " : ""}server running at http://localhost:${PORT}`);
  });
}

export default server;
