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
import { resolveExplorerUrl }                  from "./resolver.mjs";
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

// Routes gateway.pay()'s two fetch calls directly through handleCite,
// bypassing the network. Called only from handleDemoCite's real-mode path.
async function _fakeCiteResponse(articleId, init) {
  // Always lowercase header keys — Node's HTTP server does this automatically but
  // our mock doesn't. handleCite reads req.headers["payment-signature"] (lowercase);
  // if "Payment-Signature" arrives with original casing the lookup misses and the
  // server returns 402 again, causing gateway.pay() to throw "Payment Required".
  const reqHeaders = {};
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => { reqHeaders[k.toLowerCase()] = v; });
  } else if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      reqHeaders[k.toLowerCase()] = String(v);
    }
  }

  _fakeCiteResponse._n = (_fakeCiteResponse._n ?? 0) + 1;
  console.log(`[fakeCite #${_fakeCiteResponse._n}] method=${init.method ?? "GET"} headers=[${Object.keys(reqHeaders).join(",")}] hasSig=${!!reqHeaders["payment-signature"]}`);

  // Normalise body (gateway.pay sends JSON strings)
  let bodyObj = {};
  if (init.body) {
    try { bodyObj = typeof init.body === "string" ? JSON.parse(init.body) : init.body; }
    catch { /* leave as {} */ }
  }

  const mockReq = {
    method:  init.method ?? "GET",
    url:     `/cite/${articleId}`,
    headers: reqHeaders,
    body:    bodyObj,           // picked up by body() helper's req.body fast-path
    socket:  { remoteAddress: "127.0.0.1" },
  };

  let respStatus = 200;
  const respHeaders = {};
  let respBody = "";

  const mockRes = {
    headersSent: false,
    writeHead(status, headers) {
      respStatus = status;
      if (headers) Object.assign(respHeaders, headers);
      this.headersSent = true;
    },
    end(data) { respBody = data ?? ""; },
  };

  await handleCite(mockReq, mockRes, { articleId });
  console.log(`[fakeCite #${_fakeCiteResponse._n}] → status=${respStatus} body=${String(respBody).slice(0, 120)}`);

  return new Response(respBody, {
    status:  respStatus,
    headers: new Headers(
      Object.fromEntries(Object.entries(respHeaders).map(([k, v]) => [k, String(v)]))
    ),
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

  // ── Real mode: GatewayClient drives the x402 handshake in-process ───────────
  // gateway.pay() makes two HTTP requests to the cite endpoint:
  //   1. Initial probe → expects 402 + PAYMENT-REQUIRED header
  //   2. Signed retry  → expects 200 with settlement receipt
  // On Vercel there is no localhost and no reliable self-URL, so we intercept
  // globalThis.fetch for those two calls and route them directly through
  // handleCite — no network I/O, no URL construction, works everywhere.
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  console.log(`[demo/cite] BUYER_PRIVATE_KEY present: ${!!privateKey}, prefix: ${privateKey?.slice(0,6) ?? "MISSING"}`);
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

  // Sentinel URL — never actually fetched; interceptor matches on the path.
  const citeUrl      = `http://internal/cite/${articleId}`;
  const citePath     = `/cite/${articleId}`;
  const extraHeaders = simulatedPayer ? { "X-Test-Payer": simulatedPayer } : {};

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const href = typeof input === "string" ? input
               : input instanceof URL      ? input.href
               : String(input.url ?? input);
    let pathname;
    try { pathname = new URL(href).pathname; } catch { pathname = href; }
    if (pathname === citePath) return _fakeCiteResponse(articleId, init);
    return originalFetch(input, init);
  };

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
  } finally {
    globalThis.fetch = originalFetch;
  }

  send(res, 200, {
    ...result.data,
    formattedAmount: result.formattedAmount,
    transaction:     result.transaction || result.data?.transaction,
    dryRun:          false,
  });
}

async function handleResolveTx(req, res) {
  const url = new URL(req.url, "http://localhost");
  const transferId = url.searchParams.get("id");
  if (!transferId) return send(res, 400, { error: "Missing ?id=<uuid>" });

  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey) return send(res, 500, { error: "BUYER_PRIVATE_KEY not set" });

  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });

  const explorerUrl = await resolveExplorerUrl(transferId, gateway);
  send(res, 200, { explorerUrl });
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
    if (method === "GET"  && pathname === "/audit")      return await handleAudit(req, res);
    if (method === "GET"  && pathname === "/resolve-tx") return await handleResolveTx(req, res);

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
