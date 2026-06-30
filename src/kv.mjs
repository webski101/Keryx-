/**
 * KV store abstraction.
 * When KV_REST_API_URL + KV_REST_API_TOKEN are set → @vercel/kv (Upstash Redis).
 * Otherwise → in-memory fallback for local dev without a KV store.
 *
 * API surface used by registry.mjs and breaker.mjs:
 *   get, set, del, exists,
 *   sadd, smembers, srem,
 *   zadd, zrange, zremrangebyscore, zcard, expire,
 *   lpush, ltrim, lrange
 */

class MemKv {
  constructor() {
    this._kv    = new Map();
    this._sets  = new Map();
    this._zsets = new Map(); // key -> [{score, member}] sorted by score
    this._lists = new Map();
  }

  async get(key)              { return this._kv.get(key) ?? null; }
  async set(key, val, o = {}) {
    this._kv.set(key, val);
    if (o.ex) setTimeout(() => this._kv.delete(key), o.ex * 1000);
    return "OK";
  }
  async del(...keys)  { let n = 0; for (const k of keys) if (this._kv.delete(k)) n++; return n; }
  async exists(key)   { return this._kv.has(key) ? 1 : 0; }

  async sadd(key, ...members) {
    if (!this._sets.has(key)) this._sets.set(key, new Set());
    const s = this._sets.get(key); let n = 0;
    for (const m of members) if (!s.has(m)) { s.add(m); n++; }
    return n;
  }
  async smembers(key) { return [...(this._sets.get(key) ?? [])]; }
  async srem(key, ...members) {
    const s = this._sets.get(key); if (!s) return 0;
    let n = 0; for (const m of members) if (s.delete(m)) n++;
    return n;
  }

  async zadd(key, ...entries) {
    if (!this._zsets.has(key)) this._zsets.set(key, []);
    const zs = this._zsets.get(key); let added = 0;
    for (const e of entries) {
      const i = zs.findIndex(x => x.member === e.member);
      if (i === -1) { zs.push({ score: e.score, member: e.member }); added++; }
      else zs[i].score = e.score;
    }
    zs.sort((a, b) => a.score - b.score);
    return added;
  }
  async zremrangebyscore(key, min, max) {
    const zs = this._zsets.get(key); if (!zs) return 0;
    const lo = min === "-inf" ? -Infinity : Number(min);
    const hi = max === "+inf" ?  Infinity : Number(max);
    const keep = zs.filter(e => e.score < lo || e.score > hi);
    const removed = zs.length - keep.length;
    this._zsets.set(key, keep);
    return removed;
  }
  // opts: { byScore?: boolean }  (index range if byScore is falsy)
  async zrange(key, min, max, opts = {}) {
    const zs = this._zsets.get(key) ?? [];
    if (opts.byScore) {
      const lo = min === "-inf" ? -Infinity : Number(min);
      const hi = max === "+inf" ?  Infinity : Number(max);
      return zs.filter(e => e.score >= lo && e.score <= hi).map(e => e.member);
    }
    const start = Number(min) < 0 ? Math.max(0, zs.length + Number(min)) : Number(min);
    const stop  = Number(max) < 0 ? zs.length + Number(max) : Number(max);
    return zs.slice(start, stop + 1).map(e => e.member);
  }
  async zcard(key)          { return (this._zsets.get(key) ?? []).length; }
  async expire(_key, _secs) { return 1; } // in-memory entries cleaned by score pruning

  async lpush(key, ...values) {
    if (!this._lists.has(key)) this._lists.set(key, []);
    const l = this._lists.get(key);
    for (let i = values.length - 1; i >= 0; i--) l.unshift(values[i]);
    return l.length;
  }
  async ltrim(key, start, stop) {
    const l = this._lists.get(key); if (!l) return;
    this._lists.set(key, stop === -1 ? l.slice(start) : l.slice(start, stop + 1));
  }
  async lrange(key, start, stop) {
    const l = this._lists.get(key) ?? [];
    return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
  }
}

let _store = null;

export async function getKv() {
  if (_store) return _store;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { kv } = await import("@vercel/kv");
    _store = kv;
  } else {
    console.log("[kv] No KV_REST_API_URL — using in-memory fallback");
    _store = new MemKv();
  }
  return _store;
}
