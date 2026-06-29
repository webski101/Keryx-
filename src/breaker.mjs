/**
 * Deterministic circuit breaker — 5 named rules, checked in order.
 * First failure wins. Every decision is appended to the in-memory audit log.
 */

const WINDOW_MS = 60_000;          // rolling window for rate/volume rules
const REPLAY_GAP_MS = 5_000;       // min gap between same payer+article
const MAX_SINGLE_PAYOUT_USD = 1.0; // sanity cap
const PAYER_WINDOW_CAP_USD = 0.05; // max per payer per 60 s
const ARTICLE_VOLUME_CAP = 20;     // max citations per article per 60 s

const audit = [];                  // in-memory audit log

// { "payerAddr:articleId" -> timestamps[] }
const replayTracker = new Map();
// { payerAddr -> [{ ts, amountUsdc }] }
const payerSpend = new Map();
// { articleId -> timestamps[] }
const articleVolume = new Map();
// paused article set
const pausedArticles = new Set();

function now() { return Date.now(); }

function prune(arr, cutoff) {
  const i = arr.findIndex((x) => (x.ts ?? x) >= cutoff);
  return i === -1 ? [] : arr.slice(i);
}

function appendAudit(entry) {
  audit.push({ ...entry, timestamp: new Date().toISOString() });
  if (audit.length > 10_000) audit.shift(); // cap memory
}

export function getAudit() { return [...audit]; }

export function clearAudit() { audit.length = 0; }

/**
 * Check all rules in order. Returns { allowed: true } or
 * { allowed: false, rule, reason }.
 */
export function check({ payer, articleId, amountUsdc, similarity }) {
  const t = now();
  const key = `${payer}:${articleId}`;

  // --- 1. LOW_SIMILARITY ---
  if (similarity < 0.3) {
    const entry = { rule: "LOW_SIMILARITY", allowed: false, payer, articleId, similarity, amountUsdc };
    appendAudit(entry);
    return { allowed: false, rule: "LOW_SIMILARITY", reason: `Similarity ${similarity.toFixed(3)} < 0.30` };
  }

  // --- 2. AMOUNT_TOO_LARGE ---
  if (parseFloat(amountUsdc) > MAX_SINGLE_PAYOUT_USD) {
    const entry = { rule: "AMOUNT_TOO_LARGE", allowed: false, payer, articleId, similarity, amountUsdc };
    appendAudit(entry);
    return { allowed: false, rule: "AMOUNT_TOO_LARGE", reason: `$${amountUsdc} exceeds $${MAX_SINGLE_PAYOUT_USD} cap` };
  }

  // --- 3. REPLAY_TOO_SOON ---
  const replayTimes = prune(replayTracker.get(key) ?? [], t - REPLAY_GAP_MS);
  if (replayTimes.length > 0) {
    const entry = { rule: "REPLAY_TOO_SOON", allowed: false, payer, articleId, similarity, amountUsdc };
    appendAudit(entry);
    return { allowed: false, rule: "REPLAY_TOO_SOON", reason: "Same payer+article within 5 s" };
  }

  // --- 4. PAYER_RATE_CAP ---
  const spendEntries = prune(payerSpend.get(payer) ?? [], t - WINDOW_MS);
  const totalSpent = spendEntries.reduce((s, e) => s + e.amount, 0);
  if (totalSpent + parseFloat(amountUsdc) > PAYER_WINDOW_CAP_USD) {
    const entry = { rule: "PAYER_RATE_CAP", allowed: false, payer, articleId, similarity, amountUsdc };
    appendAudit(entry);
    return { allowed: false, rule: "PAYER_RATE_CAP", reason: `Payer would exceed $${PAYER_WINDOW_CAP_USD}/60 s window` };
  }

  // --- 5. ARTICLE_VOLUME_ANOMALY / ARTICLE_PAUSED ---
  if (pausedArticles.has(articleId)) {
    const entry = { rule: "ARTICLE_PAUSED", allowed: false, payer, articleId, similarity, amountUsdc };
    appendAudit(entry);
    return { allowed: false, rule: "ARTICLE_PAUSED", reason: "Article auto-paused due to volume anomaly" };
  }
  const volTimes = prune(articleVolume.get(articleId) ?? [], t - WINDOW_MS);
  if (volTimes.length >= ARTICLE_VOLUME_CAP) {
    pausedArticles.add(articleId);
    const entry = { rule: "ARTICLE_VOLUME_ANOMALY", allowed: false, payer, articleId, similarity, amountUsdc };
    appendAudit(entry);
    return { allowed: false, rule: "ARTICLE_VOLUME_ANOMALY", reason: `Article cited >20 times in 60 s — auto-paused` };
  }

  // --- ALLOWED — update state ---
  replayTracker.set(key, [...replayTimes, t]);
  payerSpend.set(payer, [...spendEntries, { ts: t, amount: parseFloat(amountUsdc) }]);
  articleVolume.set(articleId, [...volTimes, t]);

  const entry = { rule: "SETTLED", allowed: true, payer, articleId, similarity, amountUsdc };
  appendAudit(entry);
  return { allowed: true };
}

export function unpause(articleId) {
  pausedArticles.delete(articleId);
}

export function isPaused(articleId) {
  return pausedArticles.has(articleId);
}
