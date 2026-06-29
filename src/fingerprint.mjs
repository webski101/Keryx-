/**
 * Zero-dependency w-shingling fingerprinter.
 * k=5 sliding-window word n-grams, hashed via node:crypto.
 *
 * containment() is the right metric for citation matching:
 * a cited snippet is much shorter than a full article, so
 * jaccard would be unfairly penalised by the size difference.
 */

import { createHash } from "node:crypto";

const K = 5;

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingle(tokens, k = K) {
  const set = new Set();
  for (let i = 0; i <= tokens.length - k; i++) {
    const gram = tokens.slice(i, i + k).join(" ");
    set.add(createHash("sha1").update(gram).digest("hex").slice(0, 8));
  }
  return set;
}

/**
 * What fraction of candidate's shingles appear in source?
 * Range [0, 1]. Returns 0 if candidate has no shingles.
 */
export function containment(candidate, source) {
  const cShingles = shingle(tokenize(candidate));
  const sShingles = shingle(tokenize(source));
  if (cShingles.size === 0) return 0;
  let overlap = 0;
  for (const h of cShingles) {
    if (sShingles.has(h)) overlap++;
  }
  return overlap / cShingles.size;
}

/**
 * Jaccard similarity — secondary diagnostic.
 */
export function jaccard(a, b) {
  const sA = shingle(tokenize(a));
  const sB = shingle(tokenize(b));
  if (sA.size === 0 && sB.size === 0) return 1;
  let intersection = 0;
  for (const h of sA) {
    if (sB.has(h)) intersection++;
  }
  const union = sA.size + sB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Pre-compute and return shingle set for a text (for storage).
 */
export function computeShingles(text) {
  return [...shingle(tokenize(text))];
}
