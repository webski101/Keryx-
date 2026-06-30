/**
 * Deterministic circuit breaker — 5 named rules, checked in order.
 * State is stored in Vercel KV so it survives across serverless invocations.
 * Falls back to in-memory KV for local dev.
 */

import { getKv } from "./kv.mjs";

const WINDOW_MS            = 60_000;
const REPLAY_GAP_MS        = 5_000;
const MAX_SINGLE_PAYOUT_USD = 1.0;
const PAYER_WINDOW_CAP_USD  = 0.05;
const ARTICLE_VOLUME_CAP    = 20;

function now() { return Date.now(); }

function uid() { return Math.random().toString(36).slice(2); }

async function appendAudit(kv, entry) {
  const record = { ...entry, timestamp: new Date().toISOString() };
  await kv.lpush("audit", record);
  await kv.ltrim("audit", 0, 9_999); // cap at 10 000 entries
}

export async function getAudit() {
  const kv      = await getKv();
  const entries = await kv.lrange("audit", 0, -1);
  // lpush adds newest first; reverse so callers get chronological order
  return entries.slice().reverse();
}

export async function clearAudit() {
  const kv = await getKv();
  await kv.del("audit");
}

/**
 * Check all rules in order. Mutates KV state for allowed requests.
 * Returns { allowed: true } or { allowed: false, rule, reason }.
 */
export async function check({ payer, articleId, amountUsdc, similarity }) {
  const kv = await getKv();
  const t  = now();

  // ── 1. LOW_SIMILARITY ────────────────────────────────────────────────────────
  if (similarity < 0.3) {
    await appendAudit(kv, { rule: "LOW_SIMILARITY", allowed: false, payer, articleId, similarity, amountUsdc });
    return { allowed: false, rule: "LOW_SIMILARITY", reason: `Similarity ${similarity.toFixed(3)} < 0.30` };
  }

  // ── 2. AMOUNT_TOO_LARGE ──────────────────────────────────────────────────────
  if (parseFloat(amountUsdc) > MAX_SINGLE_PAYOUT_USD) {
    await appendAudit(kv, { rule: "AMOUNT_TOO_LARGE", allowed: false, payer, articleId, similarity, amountUsdc });
    return { allowed: false, rule: "AMOUNT_TOO_LARGE", reason: `$${amountUsdc} exceeds $${MAX_SINGLE_PAYOUT_USD} cap` };
  }

  // ── 3. REPLAY_TOO_SOON ───────────────────────────────────────────────────────
  const replayKey = `replay:${payer}:${articleId}`;
  await kv.zremrangebyscore(replayKey, 0, t - REPLAY_GAP_MS - 1);
  const replayCount = await kv.zcard(replayKey);
  if (replayCount > 0) {
    await appendAudit(kv, { rule: "REPLAY_TOO_SOON", allowed: false, payer, articleId, similarity, amountUsdc });
    return { allowed: false, rule: "REPLAY_TOO_SOON", reason: "Same payer+article within 5 s" };
  }

  // ── 4. PAYER_RATE_CAP ────────────────────────────────────────────────────────
  const spendKey = `spend:${payer}`;
  await kv.zremrangebyscore(spendKey, 0, t - WINDOW_MS - 1);
  const spendMembers = await kv.zrange(spendKey, t - WINDOW_MS, "+inf", { byScore: true });
  // member format: "{amount}:{uid}"
  const totalSpent = spendMembers.reduce((s, m) => s + parseFloat(m.split(":")[0]), 0);
  if (totalSpent + parseFloat(amountUsdc) > PAYER_WINDOW_CAP_USD) {
    await appendAudit(kv, { rule: "PAYER_RATE_CAP", allowed: false, payer, articleId, similarity, amountUsdc });
    return { allowed: false, rule: "PAYER_RATE_CAP", reason: `Payer would exceed $${PAYER_WINDOW_CAP_USD}/60 s window` };
  }

  // ── 5. ARTICLE_PAUSED / ARTICLE_VOLUME_ANOMALY ───────────────────────────────
  const pauseKey = `paused:${articleId}`;
  const isPaused = await kv.exists(pauseKey);
  if (isPaused) {
    await appendAudit(kv, { rule: "ARTICLE_PAUSED", allowed: false, payer, articleId, similarity, amountUsdc });
    return { allowed: false, rule: "ARTICLE_PAUSED", reason: "Article auto-paused due to volume anomaly" };
  }
  const volKey = `vol:${articleId}`;
  await kv.zremrangebyscore(volKey, 0, t - WINDOW_MS - 1);
  const volCount = await kv.zcard(volKey);
  if (volCount >= ARTICLE_VOLUME_CAP) {
    await kv.set(pauseKey, 1, { ex: 3600 }); // auto-unpause after 1 hour
    await appendAudit(kv, { rule: "ARTICLE_VOLUME_ANOMALY", allowed: false, payer, articleId, similarity, amountUsdc });
    return { allowed: false, rule: "ARTICLE_VOLUME_ANOMALY", reason: "Article cited >20 times in 60 s — auto-paused" };
  }

  // ── ALLOWED — update state ───────────────────────────────────────────────────
  const tag = uid();
  await kv.zadd(replayKey, { score: t, member: `${t}:${tag}` });
  await kv.expire(replayKey, Math.ceil(REPLAY_GAP_MS / 1000) + 5);

  await kv.zadd(spendKey, { score: t, member: `${amountUsdc}:${tag}` });
  await kv.expire(spendKey, Math.ceil(WINDOW_MS / 1000) + 5);

  await kv.zadd(volKey, { score: t, member: `${t}:${tag}` });
  await kv.expire(volKey, Math.ceil(WINDOW_MS / 1000) + 5);

  await appendAudit(kv, { rule: "SETTLED", allowed: true, payer, articleId, similarity, amountUsdc });
  return { allowed: true };
}

export async function unpause(articleId) {
  const kv = await getKv();
  await kv.del(`paused:${articleId}`);
}

export async function isPaused(articleId) {
  const kv = await getKv();
  return !!(await kv.exists(`paused:${articleId}`));
}
