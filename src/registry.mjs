/**
 * Article registry backed by Vercel KV (Upstash Redis).
 * Falls back to in-memory store for local dev without KV env vars.
 *
 * All exports are async. Stable id = SHA-1 of URL (16 hex chars).
 */

import { createHash } from "node:crypto";
import { containment, computeShingles } from "./fingerprint.mjs";
import { getKv } from "./kv.mjs";

export function urlToId(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

export async function register(article) {
  const { url, title, text, priceUsdc = "0.001", payTo } = article;
  if (!url || !text) throw new Error("url and text are required");
  const id  = urlToId(url);
  const kv  = await getKv();
  const existing = await kv.get(`article:${id}`);
  const record = {
    id, url,
    title: title || url,
    text,
    priceUsdc: String(priceUsdc),
    payTo: payTo || process.env.SELLER_ADDRESS || "0x0000000000000000000000000000000000000000",
    shingles: computeShingles(text),
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await kv.set(`article:${id}`, record);
  await kv.sadd("article_ids", id);
  return id;
}

export async function get(id) {
  const kv = await getKv();
  return (await kv.get(`article:${id}`)) ?? null;
}

export async function list() {
  const kv  = await getKv();
  const ids = await kv.smembers("article_ids");
  if (!ids || ids.length === 0) return [];
  const records = await Promise.all(ids.map(id => kv.get(`article:${id}`)));
  return records.filter(Boolean);
}

export async function findBestMatch(citedText) {
  const articles = await list();
  if (articles.length === 0) return null;
  let best = null, bestScore = -1;
  for (const article of articles) {
    const score = containment(citedText, article.text);
    if (score > bestScore) { bestScore = score; best = article; }
  }
  return { article: best, score: bestScore };
}

export async function remove(id) {
  const kv = await getKv();
  await kv.del(`article:${id}`);
  await kv.srem("article_ids", id);
}
