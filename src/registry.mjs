/**
 * Article registry backed by data/articles.json.
 * Stable id = SHA-1 of the article URL (hex, 16 chars).
 * Re-registering the same URL updates in place.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { containment, computeShingles } from "./fingerprint.mjs";

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
const FILE = DATA_DIR + "articles.json";

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(db) {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export function urlToId(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

/**
 * Register or update an article.
 * @param {object} article { url, title, text, priceUsdc, payTo }
 * @returns {string} id
 */
export function register(article) {
  const { url, title, text, priceUsdc = "0.001", payTo } = article;
  if (!url || !text) throw new Error("url and text are required");
  const id = urlToId(url);
  const db = load();
  db[id] = {
    id,
    url,
    title: title || url,
    text,
    priceUsdc: String(priceUsdc),
    payTo: payTo || process.env.SELLER_ADDRESS || "0x0000000000000000000000000000000000000000",
    shingles: computeShingles(text),
    registeredAt: db[id]?.registeredAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  save(db);
  return id;
}

export function get(id) {
  return load()[id] ?? null;
}

export function list() {
  return Object.values(load());
}

/**
 * Find the best-matching article for a cited text snippet.
 * Returns { article, score } or null if registry is empty.
 */
export function findBestMatch(citedText) {
  const articles = list();
  if (articles.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const article of articles) {
    const score = containment(citedText, article.text);
    if (score > bestScore) {
      bestScore = score;
      best = article;
    }
  }
  return { article: best, score: bestScore };
}

export function remove(id) {
  const db = load();
  delete db[id];
  save(db);
}
