/**
 * RSS/Atom feed ingester.
 * Fetches any public feed, parses items, registers them as articles.
 * Re-running updates in place (same URL → same id).
 *
 * Usage:
 *   node scripts/ingest-rss.mjs [feed-url]
 *
 * Default feed: RSSHub Hacker News front page (no auth needed)
 */

import { register, urlToId, list } from "../src/registry.mjs";

const SELLER = process.env.SELLER_ADDRESS ?? "0xSELLER0000000000000000000000000000000001";
const DEFAULT_FEED = "https://rsshub.app/hackernews";
const feedUrl = process.argv[2] ?? DEFAULT_FEED;

console.log(`Fetching: ${feedUrl}`);

let xml;
try {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "Keryx/1.0 (citation-toll-ingester)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  xml = await res.text();
} catch (e) {
  console.error("Feed fetch failed:", e.message);
  process.exit(1);
}

// Simple regex extraction — no XML library needed.
function extractAll(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
  }
  return results;
}

function extractFirst(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : null;
}

// Split into <item> blocks (RSS) or <entry> blocks (Atom)
const itemTag = xml.includes("<entry") ? "entry" : "item";
const itemBlocks = [];
const itemRe = new RegExp(`<${itemTag}[\\s>][\\s\\S]*?<\\/${itemTag}>`, "gi");
let m;
while ((m = itemRe.exec(xml)) !== null) {
  itemBlocks.push(m[0]);
}

console.log(`Found ${itemBlocks.length} items`);

let registered = 0;
let skipped = 0;

for (const block of itemBlocks) {
  const title = extractFirst(block, "title");
  const link =
    extractFirst(block, "link") ??
    (() => { const m2 = block.match(/href="([^"]+)"/); return m2 ? m2[1] : null; })();
  const description =
    extractFirst(block, "description") ??
    extractFirst(block, "summary") ??
    extractFirst(block, "content");

  if (!link || !title) { skipped++; continue; }

  // Strip HTML tags for plain text
  const text = (description ?? title)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length < 30) { skipped++; continue; }

  const id = register({
    url: link,
    title,
    text,
    priceUsdc: "0.001",
    payTo: SELLER,
  });

  console.log(`  ✓ [${id}] ${title.slice(0, 55)}`);
  registered++;
}

const total = list().length;
console.log(`\nIngested ${registered} articles (${skipped} skipped). Registry total: ${total}`);
